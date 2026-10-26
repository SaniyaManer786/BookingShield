"""
SMART ST Control Center - Real-Time Person Detection & Passenger Counting Service
Powered by FastAPI, OpenCV, and Ultralytics YOLOv8 (COCO Person Class 0)
"""

import os
import sys
import time
import base64
import logging
from typing import List, Optional, Any, Dict
from datetime import datetime, timezone

try:
    import numpy as np
except ImportError:
    np = None

try:
    import cv2
except ImportError:
    cv2 = None

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("smartst-vision")

# Load environment variables from .env if present
try:
    from dotenv import load_dotenv
    env_paths = [
        os.path.join(os.path.dirname(__file__), "..", ".env"),
        os.path.join(os.path.dirname(__file__), ".env"),
    ]
    for ep in env_paths:
        if os.path.exists(ep):
            load_dotenv(ep)
            break
except Exception:
    pass

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, Field, StrictInt, model_validator

# Local imports
try:
    from . import conductor_db
    from . import alert_dispatch
    from . import etm_db
except Exception:
    import conductor_db
    import alert_dispatch
    import etm_db

# Initialize FastAPI app
app = FastAPI(
    title="SMART ST Vision API",
    description="Browser camera frame inference, ETM ticketing and passenger monitoring using YOLO and OpenCV",
    version="1.19.4"
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    errors = exc.errors()
    if request.url.path.startswith("/api/conductor/checkpoint"):
        for err in errors:
            msg = str(err.get("msg", ""))
            if "negative expected occupancy" in msg.lower():
                return JSONResponse(status_code=400, content={"detail": "Movement entry would produce negative expected occupancy (startingOnboard + boarded - alighted < 0)."})
            if "cannot be negative" in msg.lower():
                return JSONResponse(status_code=400, content={"detail": msg.replace("Value error, ", "")})
            if "whole integer" in msg.lower():
                return JSONResponse(status_code=400, content={"detail": msg.replace("Value error, ", "")})
            if "current checkpoint is required" in msg.lower():
                return JSONResponse(status_code=400, content={"detail": "Current checkpoint is required."})
        return JSONResponse(status_code=400, content={"detail": errors[0].get("msg", "Validation error").replace("Value error, ", "")})
    return JSONResponse(status_code=422, content={"detail": errors})


# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://localhost:8001",
        "http://127.0.0.1:8001",
        "*"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model state
yolo_model = None
model_device = "cpu"
model_name = "YOLOv8n"
MODEL_PATH = os.environ.get("YOLO_MODEL_PATH", "yolov8n.pt")

DEFAULT_YOLO_CONFIDENCE_THRESHOLD = 0.25


def get_yolo_confidence_threshold() -> float:
    raw = os.environ.get("YOLO_CONFIDENCE_THRESHOLD")
    if raw is None or raw.strip() == "":
        return DEFAULT_YOLO_CONFIDENCE_THRESHOLD
    try:
        val = float(raw.strip())
        if 0.01 <= val <= 0.99:
            return round(val, 2)
        logger.warning(
            f"Configured YOLO_CONFIDENCE_THRESHOLD='{raw}' out of valid bounds (0.01-0.99). "
            f"Falling back to backend default {DEFAULT_YOLO_CONFIDENCE_THRESHOLD}."
        )
        return DEFAULT_YOLO_CONFIDENCE_THRESHOLD
    except ValueError:
        logger.warning(
            f"Invalid float for YOLO_CONFIDENCE_THRESHOLD='{raw}'. "
            f"Falling back to backend default {DEFAULT_YOLO_CONFIDENCE_THRESHOLD}."
        )
        return DEFAULT_YOLO_CONFIDENCE_THRESHOLD


def find_model_path():
    candidates = [
        MODEL_PATH,
        os.path.join(os.path.dirname(__file__), "yolov8n.pt"),
        os.path.join(os.path.dirname(__file__), "..", "yolov8n.pt"),
        os.path.abspath("yolov8n.pt"),
        os.path.abspath(os.path.join("backend", "yolov8n.pt"))
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return os.path.abspath(path)
    return "yolov8n.pt"


def load_model():
    global yolo_model, model_device
    try:
        from ultralytics import YOLO
        import torch

        model_device = "cuda" if torch.cuda.is_available() else "cpu"
        model_file = find_model_path()
        logger.info(f"Loading YOLO model from '{model_file}' on device '{model_device}'...")
        yolo_model = YOLO(model_file)
        active_conf = get_yolo_confidence_threshold()
        if np is not None:
            warmup_img = np.zeros((320, 320, 3), dtype=np.uint8)
            yolo_model(warmup_img, classes=[0], conf=active_conf, verbose=False)
        logger.info(
            f"YOLO model successfully loaded and warmed up! Target class: Person (ID 0). Backend confidence threshold: {active_conf}."
        )
    except Exception as e:
        logger.error(f"Failed to load YOLO model: {e}")
        yolo_model = None


@app.on_event("startup")
async def startup_event():
    try:
        conductor_db.init_db()
    except Exception as e:
        logger.error(f"Error initializing conductor database: {e}")
    try:
        alert_dispatch.init_db()
    except Exception as e:
        logger.error(f"Error initializing mismatch alert database: {e}")
    try:
        etm_db.init_db()
    except Exception as e:
        logger.error(f"Error initializing ETM ticketing database: {e}")
    try:
        load_model()
    except Exception as e:
        logger.error(f"Error loading model: {e}")


# ---------------------------------------------------------------------------
# Detection schemas and endpoints (real YOLO/OpenCV person inference)
# ---------------------------------------------------------------------------

class BoundingBox(BaseModel):
    box: List[float] = Field(..., description="[x1, y1, x2, y2] bounding box coordinates")
    x1: float = Field(..., description="Top-left X coordinate in pixels")
    y1: float = Field(..., description="Top-left Y coordinate in pixels")
    x2: float = Field(..., description="Bottom-right X coordinate in pixels")
    y2: float = Field(..., description="Bottom-right Y coordinate in pixels")
    width: float = Field(..., description="Box width in pixels")
    height: float = Field(..., description="Box height in pixels")
    confidence: float = Field(..., description="Detection confidence score between 0.0 and 1.0")
    class_id: int = Field(0, description="COCO class index (0 for person)")
    label: str = Field("person", description="Detected class name")
    track_id: Optional[int] = Field(None, description="Persistent tracking identifier if tracking is enabled")


class DetectionRequest(BaseModel):
    image: str = Field(..., description="Base64 encoded JPEG/PNG frame or data URL")
    track: bool = Field(False, description="Enable object tracking for persistent IDs")
    iou: float = Field(0.45, ge=0.1, le=0.95, description="Non-maximum suppression IOU threshold")
    # Confidence is intentionally backend-controlled via YOLO_CONFIDENCE_THRESHOLD.
    confidence: Optional[float] = Field(None, description="Ignored: backend controls threshold via YOLO_CONFIDENCE_THRESHOLD")
    bus_id: Optional[str] = Field("MH-12-QW-4821", description="Associated bus registration ID")


class DetectionResponse(BaseModel):
    success: bool
    count: int
    detections: List[BoundingBox]
    image_width: int
    image_height: int
    inference_time_ms: float
    total_processing_ms: float
    timestamp: str
    model_name: str
    device: str


class VisionSessionRequest(BaseModel):
    bus_id: Optional[str] = Field("MH-12-QW-4821", max_length=50)
    camera_status: str = Field("idle", max_length=50)
    model_status: str = Field("unknown", max_length=50)
    message: str = Field("", max_length=500)
    session_id: str = Field("", max_length=100)


@app.get("/")
def index():
    return {
        "service": "SMART ST Computer Vision API",
        "status": "online",
        "docs_url": "/docs",
        "health_url": "/api/health",
        "detect_url": "/api/detect"
    }


@app.get("/api/health")
@app.get("/health")
def health_check():
    """Returns the service health status, model readiness, compute device, and backend confidence threshold."""
    global yolo_model
    if yolo_model is None:
        load_model()
    db_ok = True
    try:
        conn = conductor_db.get_db_connection()
        conn.execute("SELECT 1 FROM checkpoint_submissions LIMIT 1")
        conn.close()
    except Exception as e:
        logger.error(f"Health check database error: {e}")
        db_ok = False
    return {
        "status": "healthy" if (yolo_model is not None and db_ok) else "degraded",
        "model_loaded": yolo_model is not None,
        "database_ok": db_ok,
        "database_path": conductor_db.DB_PATH,
        "model_name": model_name,
        "device": model_device,
        "confidence_threshold": get_yolo_confidence_threshold(),
        "coco_target_class": "person (ID 0)",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@app.get("/api/sample-frame")
def get_sample_frame():
    """Returns a base64 encoded benchmark image containing passengers (COCO bus.jpg) for immediate testing."""
    import ultralytics
    asset_path = os.path.join(os.path.dirname(ultralytics.__file__), "assets", "bus.jpg")
    if os.path.exists(asset_path):
        with open(asset_path, "rb") as f:
            b64 = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("utf-8")
        return {"success": True, "image": b64, "name": "COCO bus.jpg (people visible)"}
    return {"success": False, "image": None}


def decode_base64_image(image_str: str) -> Any:
    """Decodes a base64 string or data URL into an OpenCV BGR image."""
    if cv2 is None or np is None:
        raise HTTPException(status_code=503, detail="Computer Vision dependencies (OpenCV / NumPy) are not installed.")
    try:
        if "," in image_str:
            # Strip data:image/...;base64, header if present
            image_str = image_str.split(",", 1)[1]
        img_bytes = base64.b64decode(image_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("cv2.imdecode returned None; invalid image format or corrupted payload.")
        return img
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {str(e)}")


@app.post("/api/detect", response_model=DetectionResponse)
def detect_people(payload: DetectionRequest):
    """
    Real-time detection endpoint.

    Receives a camera frame from the browser, decodes it with OpenCV, and runs
    YOLO inference filtered to the COCO person class (0). The confidence
    threshold is backend-configured.

    When tracking is enabled, ByteTrack assigns a persistent ID to each person
    and the response de-duplicates repeated boxes for the same track. The count
    is always the number of people visible in the current frame, so a person is
    never counted twice just because they stay in view.
    """
    global yolo_model
    if yolo_model is None:
        load_model()
        if yolo_model is None:
            raise HTTPException(
                status_code=503,
                detail="YOLO model is not initialized or weights file is missing."
            )

    t0 = time.perf_counter()

    # Step 1: Decode image with OpenCV
    img = decode_base64_image(payload.image)
    h, w = img.shape[:2]

    # Step 2: Run YOLO inference for COCO person class (0)
    conf_threshold = get_yolo_confidence_threshold()
    t_inf_start = time.perf_counter()
    try:
        if payload.track:
            # Persistent multi-object tracking (ByteTrack)
            try:
                results = yolo_model.track(
                    img,
                    classes=[0],
                    conf=conf_threshold,
                    iou=payload.iou,
                    persist=True,
                    verbose=False
                )
            except Exception as track_e:
                logger.warning(f"Tracking failed ({track_e}); attempting tracker reset and retry.")
                predictor = getattr(yolo_model, "predictor", None)
                if predictor is not None:
                    try:
                        for tracker in getattr(predictor, "trackers", None) or []:
                            reset = getattr(tracker, "reset", None)
                            if callable(reset):
                                try:
                                    reset()
                                except Exception:
                                    pass
                        predictor.__dict__.pop("trackers", None)
                        predictor.__dict__.pop("vid_path", None)
                    except Exception:
                        pass
                # Try again with tracking
                try:
                    results = yolo_model.track(
                        img,
                        classes=[0],
                        conf=conf_threshold,
                        iou=payload.iou,
                        persist=True,
                        verbose=False
                    )
                except Exception:
                    # Final fallback to non-tracking
                    logger.warning(f"Tracking failed again, falling back to detection without tracking.")
                    results = yolo_model(
                        img,
                        classes=[0],
                        conf=conf_threshold,
                        iou=payload.iou,
                        verbose=False
                    )
        else:
            results = yolo_model(
                img,
                classes=[0],
                conf=conf_threshold,
                iou=payload.iou,
                verbose=False
            )
    except Exception as e:
        logger.error(f"Inference error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")

    inference_time_ms = round((time.perf_counter() - t_inf_start) * 1000, 2)

    # Step 3: Extract structured bounding boxes (de-duplicated by track id)
    detections: List[BoundingBox] = []
    seen_track_ids = set()
    if len(results) > 0 and results[0].boxes is not None:
        boxes = results[0].boxes
        for box in boxes:
            coords = box.xyxy[0].cpu().numpy().tolist()
            x1, y1, x2, y2 = [float(c) for c in coords]
            conf = float(box.conf[0].cpu().numpy())
            cls_id = int(box.cls[0].cpu().numpy())
            track_id = int(box.id[0].cpu().numpy()) if (payload.track and box.id is not None) else None

            if track_id is not None:
                if track_id in seen_track_ids:
                    continue
                seen_track_ids.add(track_id)

            # Enforce bounds
            x1 = max(0.0, min(float(w), x1))
            y1 = max(0.0, min(float(h), y1))
            x2 = max(0.0, min(float(w), x2))
            y2 = max(0.0, min(float(h), y2))

            detections.append(BoundingBox(
                box=[round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                x1=round(x1, 1),
                y1=round(y1, 1),
                x2=round(x2, 1),
                y2=round(y2, 1),
                width=round(x2 - x1, 1),
                height=round(y2 - y1, 1),
                confidence=round(conf, 3),
                class_id=cls_id,
                label="person",
                track_id=track_id
            ))

    total_processing_ms = round((time.perf_counter() - t0) * 1000, 2)

    # Step 4: Persist the latest detection for the active bus so the Conductor
    # Panel always reads the same real count from the backend.
    try:
        conductor_db.record_latest_detection(
            bus_id=payload.bus_id or "MH-12-QW-4821",
            count=len(detections),
            inference_time_ms=inference_time_ms
        )
    except Exception as e:
        logger.warning(f"Failed to record latest detection: {e}")

    return DetectionResponse(
        success=True,
        count=len(detections),
        detections=detections,
        image_width=w,
        image_height=h,
        inference_time_ms=inference_time_ms,
        total_processing_ms=total_processing_ms,
        timestamp=datetime.now(timezone.utc).isoformat(),
        model_name=model_name,
        device=model_device
    )


@app.post("/api/detect-form", response_model=DetectionResponse)
async def detect_people_form(
    file: UploadFile = File(...),
    track: bool = Form(False)
):
    """Multipart file upload endpoint for testing or standard file submission."""
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image file")

    encoded = base64.b64encode(contents).decode("utf-8")
    req = DetectionRequest(image=encoded, track=track)
    return detect_people(req)


@app.post("/api/reset-tracker")
def reset_tracker():
    """Resets tracker state so a new camera session starts with fresh track IDs."""
    global yolo_model
    if yolo_model is None:
        return {"success": True, "message": "Tracker history cleared"}

    predictor = getattr(yolo_model, "predictor", None)
    if predictor is not None:
        for tracker in getattr(predictor, "trackers", None) or []:
            reset = getattr(tracker, "reset", None)
            if callable(reset):
                try:
                    reset()
                except Exception:
                    pass
        # Remove the tracker slots entirely so ultralytics rebuilds them on the
        # next tracking call. An empty list is NOT safe: on_predict_start treats
        # the attribute as already initialised and on_predict_postprocess_end
        # then indexes trackers[0], raising "list index out of range".
        predictor.__dict__.pop("trackers", None)
        predictor.__dict__.pop("vid_path", None)

    return {"success": True, "message": "Tracker history cleared"}


@app.post("/api/vision/session")
def record_vision_session(payload: VisionSessionRequest):
    """Stores the real browser camera/model status reported by the monitoring page."""
    bus_id = (payload.bus_id or "").strip()
    if not bus_id:
        raise HTTPException(status_code=400, detail="bus_id is required.")
    try:
        saved = conductor_db.record_camera_session(
            bus_id=bus_id,
            camera_status=payload.camera_status,
            model_status=payload.model_status,
            message=payload.message,
            session_id=payload.session_id
        )
        return {"success": True, **saved}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error recording camera session: {e}")
        raise HTTPException(status_code=500, detail="Failed to record camera session.")


@app.get("/api/conductor/camera-state")
def get_conductor_camera_state(bus_id: Optional[str] = None, bus: Optional[str] = None):
    """
    Returns the shared camera state and latest real YOLO passenger count.

    The Conductor Panel polls this endpoint; a missing count is returned as
    unavailable instead of being replaced with a hardcoded value.
    """
    target_bus = (bus_id or bus or "MH-12-QW-4821").strip()
    if not target_bus:
        raise HTTPException(status_code=400, detail="bus_id is required.")
    camera_state = conductor_db.get_camera_state(
        target_bus,
        model_available=yolo_model is not None
    )
    return {"success": True, **camera_state}


class ConductorCountRequest(BaseModel):
    bus_id: str = Field(..., min_length=1, max_length=50, description="Bus registration ID")
    trip_id: str = Field(..., min_length=1, max_length=50, description="Trip or schedule ID")
    active_tickets: int = Field(..., ge=0, le=500, description="Number of active tickets sold/validated")
    valid_passes: int = Field(..., ge=0, le=500, description="Number of valid passenger passes")
    notes: Optional[str] = Field("", max_length=500, description="Optional conductor observations or notes")
    conductor_name: Optional[str] = Field("", max_length=100, description="Conductor name or ID")


class ConductorCountResponse(BaseModel):
    success: bool
    bus_id: str
    trip_id: str
    active_tickets: int
    valid_passes: int
    total_reported: int
    notes: str
    conductor_name: str
    updated_at: str


class CheckpointSubmissionRequest(BaseModel):
    bus_id: str = Field(..., min_length=1, max_length=50, description="Bus registration ID")
    route: str = Field(..., min_length=1, max_length=100, description="Route")
    trip_id: str = Field(..., min_length=1, max_length=50, description="Trip identifier")
    checkpoint: str = Field(..., min_length=1, max_length=100, description="Current checkpoint")
    conductor_id: Optional[str] = Field("", max_length=100, description="Conductor name or ID")
    active_tickets: StrictInt = Field(..., ge=0, le=500, description="Active tickets validated at checkpoint")
    valid_passes: StrictInt = Field(..., ge=0, le=500, description="Valid passenger passes at checkpoint")
    other_authorized: Optional[StrictInt] = Field(0, ge=0, le=500, description="Other authorized passengers")
    starting_onboard: StrictInt = Field(..., ge=0, le=500, description="Passengers onboard at start of counting period")
    boarded: Optional[StrictInt] = Field(0, ge=0, le=500, description="Passengers boarded during period")
    alighted: Optional[StrictInt] = Field(0, ge=0, le=500, description="Passengers alighted during period")
    notes: Optional[str] = Field("", max_length=500, description="Operational notes")
    camera_estimate: Optional[StrictInt] = Field(None, ge=0, le=500, description="Optional explicit camera estimate snapshot")
    camera_detection_time: Optional[str] = Field("", max_length=100, description="Timestamp of camera detection snapshot")
    camera_available: Optional[bool] = Field(
        None,
        description="False when the panel knows the camera count is unavailable/stale; prevents attaching a stale snapshot."
    )
    use_ticketing_totals: Optional[bool] = Field(
        True,
        description="Use valid ETM tickets and passes as the authoritative passenger totals when records exist."
    )


class CheckpointSubmissionResponse(BaseModel):
    success: bool
    id: int
    bus_trip_id: Optional[int] = None
    expected_count_id: Optional[int] = None
    vision_count_id: Optional[int] = None
    bus_id: str
    route: str
    trip_id: str
    checkpoint: str
    conductor_id: str
    active_tickets: int
    valid_passes: int
    other_authorized: int
    starting_onboard: int
    boarded: int
    alighted: int
    reported_passengers: int
    expected_onboard: int
    camera_estimate: Optional[int]
    camera_detection_time: Optional[str] = ""
    difference: Optional[int]
    difference_abs: Optional[int] = None
    reported_difference: Optional[int] = None
    comparison_status: str
    comparison_status_label: Optional[str] = None
    camera_status: Optional[str] = ""
    ticket_count: int = 0
    ticket_passengers: int = 0
    pass_count: int = 0
    pass_passengers: int = 0
    ticket_revenue: float = 0.0
    ticketing_source: str = "manual"
    ticket_summary: Optional[Dict[str, Any]] = None
    alert: Optional[Dict[str, Any]] = None
    notes: str
    created_at: str


@app.get("/api/conductor/buses")
def get_conductor_buses():
    """Returns the fleet buses available for conductor assignment and monitoring."""
    try:
        buses = conductor_db.get_registered_buses()
        return {"success": True, "buses": buses}
    except Exception as e:
        logger.error(f"Error fetching registered buses: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/conductor/routes")
def get_conductor_routes():
    """
    Returns routes that really exist in the database (registered buses plus
    routes already used by saved checkpoints). No routes are invented.
    """
    try:
        routes = conductor_db.get_routes()
        return {"success": True, "routes": routes}
    except Exception as e:
        logger.error(f"Error fetching routes: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve routes.")


@app.get("/api/conductor/checkpoint-options")
def get_conductor_checkpoint_options(
    route: Optional[str] = None,
    bus_id: Optional[str] = None,
    bus: Optional[str] = None
):
    """
    Returns checkpoint names previously recorded in the database, optionally
    filtered by route or bus. The panel may still accept a new checkpoint name.
    """
    try:
        options = conductor_db.get_checkpoint_options(
            route=route,
            bus_id=bus_id or bus
        )
        return {"success": True, "checkpoints": options}
    except Exception as e:
        logger.error(f"Error fetching checkpoint options: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve checkpoint options.")


@app.get("/api/conductor/counts", response_model=ConductorCountResponse)
def get_conductor_counts(bus_id: str, trip_id: str):
    """Retrieves saved conductor passenger counts for a given bus and trip."""
    if not bus_id.strip() or not trip_id.strip():
        raise HTTPException(status_code=400, detail="bus_id and trip_id query parameters are required.")
    record = conductor_db.get_conductor_counts(bus_id.strip(), trip_id.strip())
    if not record:
        raise HTTPException(status_code=404, detail="No conductor record found for this bus and trip.")
    return ConductorCountResponse(
        success=True,
        bus_id=record["bus_id"],
        trip_id=record["trip_id"],
        active_tickets=record["active_tickets"],
        valid_passes=record["valid_passes"],
        total_reported=record["total_reported"],
        notes=record["notes"] or "",
        conductor_name=record["conductor_name"] or "",
        updated_at=record["updated_at"]
    )


@app.post("/api/conductor/counts", response_model=ConductorCountResponse)
def save_conductor_counts(payload: ConductorCountRequest):
    """Saves or updates manual passenger counts (active tickets + valid passes) from the conductor."""
    if payload.active_tickets < 0 or payload.valid_passes < 0:
        raise HTTPException(status_code=400, detail="Counts must be non-negative whole numbers.")
    if not payload.bus_id.strip() or not payload.trip_id.strip():
        raise HTTPException(status_code=400, detail="Bus ID and Trip ID must be non-empty strings.")

    try:
        saved = conductor_db.save_conductor_counts(
            bus_id=payload.bus_id,
            trip_id=payload.trip_id,
            active_tickets=payload.active_tickets,
            valid_passes=payload.valid_passes,
            notes=payload.notes or "",
            conductor_name=payload.conductor_name or ""
        )
        return ConductorCountResponse(
            success=True,
            bus_id=saved["bus_id"],
            trip_id=saved["trip_id"],
            active_tickets=saved["active_tickets"],
            valid_passes=saved["valid_passes"],
            total_reported=saved["total_reported"],
            notes=saved["notes"],
            conductor_name=saved["conductor_name"],
            updated_at=saved["updated_at"]
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error saving conductor counts: {e}")
        raise HTTPException(status_code=500, detail="Failed to save conductor counts.")


@app.get("/api/conductor/latest-detection")
def get_latest_detection(bus_id: Optional[str] = None, bus: Optional[str] = None):
    """Returns the latest YOLO/OpenCV detected passenger count for a given bus."""
    target_bus = (bus_id or bus or "MH-12-QW-4821").strip()
    det = conductor_db.get_latest_detection(target_bus)
    if not det:
        return {
            "success": True,
            "bus_id": target_bus,
            "detected_count": None,
            "updated_at": None,
            "message": "No camera detection frames received yet for this bus."
        }
    return {
        "success": True,
        "bus_id": det["bus_id"],
        "detected_count": det["detected_count"],
        "inference_time_ms": det.get("inference_time_ms", 0.0),
        "updated_at": det["updated_at"]
    }


@app.get("/api/conductor/comparison")
def get_conductor_comparison(
    bus_id: Optional[str] = None,
    bus: Optional[str] = None,
    trip_id: Optional[str] = None,
    tripId: Optional[str] = None
):
    """
    Returns real-time comparison between YOLO detected people and conductor reported passengers.
    Calculates:
      total_reported = active_tickets + valid_passes
      difference = detected_count - total_reported
    """
    effective_bus = (bus_id or bus or "").strip()
    effective_trip = (trip_id or tripId or "").strip()
    if not effective_bus or not effective_trip:
        raise HTTPException(status_code=400, detail="bus_id and trip_id are required.")
    comp = conductor_db.get_comparison(effective_bus, effective_trip)
    return {"success": True, **comp}


@app.get("/api/comparisons/active-trips")
@app.get("/api/conductor/trip-comparisons")
def get_active_trip_comparisons(
    tolerance: Optional[int] = Query(None, ge=0, le=100),
):
    """Returns ETM expected vs latest camera count for every active trip."""
    try:
        data = etm_db.get_active_trip_comparisons(
            model_available=yolo_model is not None,
            tolerance=tolerance,
        )
        return {"success": True, **data}
    except Exception as e:
        logger.error(f"Error building active trip comparisons: {e}")
        raise HTTPException(status_code=500, detail="Failed to build active trip comparisons.")


@app.post("/api/conductor/checkpoints", response_model=CheckpointSubmissionResponse, status_code=201)
@app.post("/api/conductor/checkpoint", response_model=CheckpointSubmissionResponse, status_code=201)
def submit_checkpoint_record(payload: CheckpointSubmissionRequest):
    """
    Submits a checkpoint passenger count record for SMART ST Conductor Panel.
    Persists sequentially to SQLite checkpoint_submissions table.
    """
    bus_id = payload.bus_id.strip()
    route = payload.route.strip()
    trip_id = payload.trip_id.strip()
    checkpoint = payload.checkpoint.strip()

    if not bus_id:
        raise HTTPException(status_code=400, detail="Bus registration number is required.")
    if not route:
        raise HTTPException(status_code=400, detail="Route is required.")
    if not trip_id:
        raise HTTPException(status_code=400, detail="Trip identifier is required.")
    if not checkpoint:
        raise HTTPException(status_code=400, detail="Current checkpoint is required.")

    if payload.starting_onboard + (payload.boarded or 0) - (payload.alighted or 0) < 0:
        raise HTTPException(
            status_code=400,
            detail="Movement entry would produce negative expected occupancy (startingOnboard + boarded - alighted < 0)."
        )
    try:
        saved = conductor_db.save_checkpoint_submission(
            bus_id=bus_id,
            route=route,
            trip_id=trip_id,
            checkpoint=checkpoint,
            conductor_id=(payload.conductor_id or "").strip(),
            active_tickets=payload.active_tickets,
            valid_passes=payload.valid_passes,
            other_authorized=payload.other_authorized or 0,
            starting_onboard=payload.starting_onboard,
            boarded=payload.boarded or 0,
            alighted=payload.alighted or 0,
            notes=(payload.notes or "").strip(),
            camera_estimate=payload.camera_estimate,
            camera_detection_time=payload.camera_detection_time,
            skip_camera_lookup=(payload.camera_available is False),
            use_ticketing_totals=(payload.use_ticketing_totals is not False),
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error persisting checkpoint submission: {e}")
        raise HTTPException(status_code=500, detail="Failed to persist checkpoint record.")

    # The record is committed at this point. The mismatch workflow is idempotent
    # and additive; a failure here must not hide a successful persistence.
    alert = None
    try:
        alert = alert_dispatch.process_checkpoint_record(saved)
    except Exception as e:
        logger.error(f"Mismatch alert workflow failed for checkpoint #{saved.get('id')}: {e}")

    return CheckpointSubmissionResponse(success=True, alert=alert, **saved)


@app.get("/api/conductor/checkpoints")
def get_checkpoint_history(
    bus_id: Optional[str] = None,
    bus: Optional[str] = None,
    trip_id: Optional[str] = None,
    tripId: Optional[str] = None,
    limit: int = 50
):
    """
    Returns recent checkpoint submissions sorted newest first.
    Filters by bus_id (or bus) and optional trip_id (or tripId).
    """
    effective_bus = bus_id or bus
    effective_trip = trip_id or tripId
    try:
        records = conductor_db.get_checkpoint_history(
            bus_id=effective_bus.strip() if effective_bus else None,
            trip_id=effective_trip.strip() if effective_trip else None,
            limit=limit
        )
        return {"success": True, "count": len(records), "checkpoints": records}
    except Exception as e:
        logger.error(f"Error fetching checkpoint history: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve checkpoint history.")


@app.get("/api/conductor/checkpoints/latest")
@app.get("/api/conductor/checkpoint/latest")
def get_latest_checkpoint(
    bus_id: Optional[str] = None,
    bus: Optional[str] = None,
    trip_id: Optional[str] = None,
    tripId: Optional[str] = None
):
    """
    Returns the latest checkpoint submission for a bus and optional trip.
    Supports query aliases: bus or bus_id, tripId or trip_id.
    """
    effective_bus = bus_id or bus
    if not effective_bus or not effective_bus.strip():
        raise HTTPException(status_code=400, detail="bus (or bus_id) query parameter is required.")
    effective_trip = trip_id or tripId
    record = conductor_db.get_latest_checkpoint(
        bus_id=effective_bus.strip(),
        trip_id=effective_trip.strip() if effective_trip else None
    )
    if not record:
        return {"success": True, "checkpoint": None, "message": "No checkpoint record found."}
    return {"success": True, "checkpoint": record}


@app.get("/api/conductor/checkpoints/{record_id}")
@app.get("/api/conductor/checkpoint/{record_id}")
def get_checkpoint_by_id(record_id: int):
    """
    Retrieves a single saved checkpoint record by its unique database ID.
    """
    record = conductor_db.get_checkpoint_by_id(record_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Checkpoint record #{record_id} not found.")
    return {"success": True, "checkpoint": record}






# ---------------------------------------------------------------------------
# ETM ticketing and passenger pass endpoints
# ---------------------------------------------------------------------------


class FareSettingsRequest(BaseModel):
    route: str = Field(..., min_length=1, max_length=100)
    full_fare: float = Field(..., gt=0, le=100000)
    half_fare: float = Field(..., ge=0, le=100000)
    free_fare: float = Field(0.0, ge=0, le=0)
    currency: str = Field("INR", min_length=1, max_length=10)


class TicketCategoryItem(BaseModel):
    category_code: str = Field(
        ...,
        min_length=1,
        max_length=32,
        validation_alias=AliasChoices("category_code", "code"),
    )
    quantity: StrictInt = Field(0, ge=0, le=500)


class TicketIssueRequest(BaseModel):
    bus_id: str = Field(..., min_length=1, max_length=50)
    route: str = Field(..., min_length=1, max_length=100)
    trip_id: str = Field(..., min_length=1, max_length=50)
    conductor_id: Optional[str] = Field("", max_length=100)
    full_count: StrictInt = Field(0, ge=0, le=500)
    half_count: StrictInt = Field(0, ge=0, le=500)
    free_count: StrictInt = Field(0, ge=0, le=500)
    items: Optional[List[TicketCategoryItem]] = Field(None, max_length=50)
    boarding_stop: Optional[str] = Field("", max_length=100)
    destination_stop: Optional[str] = Field("", max_length=100)
    client_request_id: Optional[str] = Field(
        "",
        max_length=128,
        validation_alias=AliasChoices(
            "client_request_id",
            "request_id",
            "idempotency_key",
        ),
        description="Optional idempotency key used to prevent duplicate ticket submissions.",
    )


class PassengerCategoryRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=32)
    label: str = Field(..., min_length=1, max_length=80)
    fare_basis: str = Field("full", min_length=1, max_length=10)
    sort_order: Optional[int] = Field(None, ge=0, le=9999)
    active: bool = True


class PassRegistrationRequest(BaseModel):
    bus_id: str = Field(..., min_length=1, max_length=50)
    route: str = Field(..., min_length=1, max_length=100)
    trip_id: str = Field(..., min_length=1, max_length=50)
    conductor_id: Optional[str] = Field("", max_length=100)
    pass_number: Optional[str] = Field(
        "",
        max_length=60,
        validation_alias=AliasChoices("pass_number", "pass_id"),
    )
    pass_type: str = Field("Monthly Pass", min_length=1, max_length=60)
    passenger_count: StrictInt = Field(1, ge=1, le=500)
    valid_from: Optional[str] = Field("", max_length=30)
    valid_until: Optional[str] = Field("", max_length=30)
    boarding_stop: Optional[str] = Field("", max_length=100)
    destination_stop: Optional[str] = Field("", max_length=100)
    notes: Optional[str] = Field("", max_length=500)


class DispatchRequest(BaseModel):
    bus_id: str = Field(..., min_length=1, max_length=50)
    checker_id: str = Field(..., min_length=1, max_length=50)
    location: Optional[str] = Field("", max_length=150)
    checkpoint: Optional[str] = Field("", max_length=100)
    notes: Optional[str] = Field("", max_length=500)
    alert_id: Optional[int] = Field(None, ge=1)
    route: Optional[str] = Field("", max_length=100)
    trip_id: Optional[str] = Field("", max_length=50)


class DispatchCompletionRequest(BaseModel):
    outcome: str = Field(..., min_length=1, max_length=50)
    notes: Optional[str] = Field("", max_length=1000)
    mismatch_confirmed: Optional[bool] = None


class BusTripStartRequest(BaseModel):
    bus_id: str = Field(..., min_length=1, max_length=50)
    route: str = Field(..., min_length=1, max_length=100)
    trip_id: str = Field(..., min_length=1, max_length=50)
    conductor_id: Optional[str] = Field("", max_length=100)


@app.get("/api/conductor/trips/active")
def get_active_bus_trip(bus_id: str = Query(..., min_length=1, max_length=50)):
    try:
        trip = conductor_db.get_active_bus_trip(bus_id)
        if not trip:
            raise HTTPException(status_code=404, detail="No active trip for this bus.")
        return {"success": True, "trip": trip}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching active trip: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve active trip.")


@app.get("/api/conductor/trips")
def get_bus_trips(
    bus_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    try:
        trips = conductor_db.list_bus_trips(bus_id=bus_id, status=status, limit=limit)
        return {"success": True, "trips": trips, "count": len(trips)}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error fetching trips: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve trips.")


@app.post("/api/conductor/trips")
def start_bus_trip(payload: BusTripStartRequest):
    try:
        trip = conductor_db.start_bus_trip(
            bus_id=payload.bus_id,
            route=payload.route,
            trip_id=payload.trip_id,
            conductor_id=payload.conductor_id or "",
        )
        return {"success": True, "trip": trip}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error starting trip: {e}")
        raise HTTPException(status_code=500, detail="Failed to start trip.")


@app.get("/api/conductor/trips/{trip_record_id}")
def get_bus_trip(trip_record_id: int, include_summary: bool = Query(True)):
    try:
        trip = conductor_db.get_bus_trip_by_id(trip_record_id)
        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found.")
        response = {"success": True, "trip": trip}
        if include_summary:
            response["summary"] = conductor_db.get_trip_summary(trip_record_id)
        return response
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=404, detail=str(ve))
    except Exception as e:
        logger.error(f"Error fetching trip: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve trip.")


@app.post("/api/conductor/trips/{trip_record_id}/complete")
def complete_bus_trip(trip_record_id: int):
    try:
        trip = conductor_db.complete_bus_trip(trip_record_id=trip_record_id)
        return {"success": True, "trip": trip}
    except ValueError as ve:
        message = str(ve)
        raise HTTPException(status_code=404 if message == "Trip not found." else 400, detail=message)
    except Exception as e:
        logger.error(f"Error completing trip: {e}")
        raise HTTPException(status_code=500, detail="Failed to complete trip.")


@app.get("/api/conductor/fares")
def get_conductor_fare_settings(route: str = Query(..., min_length=1, max_length=100)):
    try:
        fares = etm_db.get_fare_settings(route)
        return {"success": True, "fares": fares}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error fetching fare settings: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve fare settings.")


@app.post("/api/conductor/fares")
def save_conductor_fare_settings(payload: FareSettingsRequest):
    try:
        fares = etm_db.save_fare_settings(
            route=payload.route,
            full_fare=payload.full_fare,
            half_fare=payload.half_fare,
            free_fare=payload.free_fare,
            currency=payload.currency,
        )
        return {"success": True, "fares": fares}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error saving fare settings: {e}")
        raise HTTPException(status_code=500, detail="Failed to save fare settings.")


@app.get("/api/conductor/passenger-categories")
def get_conductor_passenger_categories(include_inactive: bool = Query(False)):
    try:
        categories = etm_db.get_passenger_categories(include_inactive=include_inactive)
        return {"success": True, "categories": categories, "count": len(categories)}
    except Exception as e:
        logger.error(f"Error fetching passenger categories: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve passenger categories.")


@app.post("/api/conductor/passenger-categories")
def save_conductor_passenger_category(payload: PassengerCategoryRequest):
    try:
        category = etm_db.save_passenger_category(
            code=payload.code,
            label=payload.label,
            fare_basis=payload.fare_basis,
            sort_order=payload.sort_order,
            active=payload.active,
        )
        return {"success": True, "category": category}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error saving passenger category: {e}")
        raise HTTPException(status_code=500, detail="Failed to save passenger category.")


@app.get("/api/conductor/route-stops")
def get_conductor_route_stops(
    route: str = Query(..., min_length=1, max_length=100),
    bus_id: Optional[str] = Query(None, max_length=50),
):
    try:
        stops = conductor_db.get_route_stops(route, bus_id=bus_id)
        return {"success": True, "route": route, "stops": stops}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error fetching route stops: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve route stops.")


@app.get("/api/conductor/tickets")
def get_conductor_tickets(
    bus_id: Optional[str] = Query(None),
    trip_id: Optional[str] = Query(None),
    route: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    try:
        tickets = etm_db.list_tickets(
            bus_id=bus_id,
            trip_id=trip_id,
            route=route,
            status=status,
            limit=limit,
        )
        return {"success": True, "tickets": tickets, "count": len(tickets)}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error fetching tickets: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve tickets.")


@app.get("/api/conductor/tickets/{ticket_id}")
def get_conductor_ticket(ticket_id: int):
    try:
        ticket = etm_db.get_ticket_by_id(ticket_id)
        if not ticket:
            raise HTTPException(status_code=404, detail=f"Ticket #{ticket_id} not found.")
        return {"success": True, "ticket": ticket}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching ticket: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve ticket.")


@app.post("/api/conductor/tickets", status_code=201)
def issue_conductor_ticket(
    payload: TicketIssueRequest,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    try:
        request_id = (payload.client_request_id or idempotency_key or "").strip()
        ticket = etm_db.issue_ticket(
            bus_id=payload.bus_id,
            route=payload.route,
            trip_id=payload.trip_id,
            conductor_id=payload.conductor_id or "",
            full_count=payload.full_count,
            half_count=payload.half_count,
            free_count=payload.free_count,
            client_request_id=request_id,
            items=[item.model_dump() for item in payload.items] if payload.items is not None else None,
            boarding_stop=payload.boarding_stop or "",
            destination_stop=payload.destination_stop or "",
        )
        duplicate = bool(ticket.pop("duplicate", False))
        summary = etm_db.get_ticketing_summary(payload.bus_id, payload.trip_id, payload.route)
        return JSONResponse(
            status_code=200 if duplicate else 201,
            content={
                "success": True,
                "ticket": ticket,
                "summary": summary,
                "duplicate": duplicate,
            },
        )
    except etm_db.IdempotencyConflictError as conflict:
        raise HTTPException(status_code=409, detail=str(conflict))
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error issuing ticket: {e}")
        raise HTTPException(status_code=500, detail="Failed to issue ticket.")


@app.post("/api/conductor/tickets/{ticket_id}/cancel")
def cancel_conductor_ticket(ticket_id: int):
    try:
        ticket = etm_db.cancel_ticket(ticket_id)
        if not ticket:
            raise HTTPException(status_code=404, detail=f"Ticket #{ticket_id} not found.")
        summary = etm_db.get_ticketing_summary(ticket["bus_id"], ticket["trip_id"], ticket["route"])
        return {"success": True, "ticket": ticket, "summary": summary}
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error cancelling ticket: {e}")
        raise HTTPException(status_code=500, detail="Failed to cancel ticket.")


@app.get("/api/conductor/passes")
def get_conductor_passes(
    bus_id: Optional[str] = Query(None),
    trip_id: Optional[str] = Query(None),
    route: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    try:
        passes = etm_db.list_passes(
            bus_id=bus_id,
            trip_id=trip_id,
            route=route,
            status=status,
            limit=limit,
        )
        return {"success": True, "passes": passes, "count": len(passes)}
    except Exception as e:
        logger.error(f"Error fetching passes: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve passes.")


@app.post("/api/conductor/passes", status_code=201)
def register_conductor_pass(payload: PassRegistrationRequest):
    try:
        passenger_pass = etm_db.register_pass(
            bus_id=payload.bus_id,
            route=payload.route,
            trip_id=payload.trip_id,
            conductor_id=payload.conductor_id or "",
            pass_number=payload.pass_number or "",
            pass_type=payload.pass_type,
            passenger_count=payload.passenger_count,
            valid_from=payload.valid_from or "",
            valid_until=payload.valid_until or "",
            boarding_stop=payload.boarding_stop or "",
            destination_stop=payload.destination_stop or "",
            notes=payload.notes or "",
        )
        summary = etm_db.get_ticketing_summary(payload.bus_id, payload.trip_id, payload.route)
        return {"success": True, "pass": passenger_pass, "summary": summary}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error registering pass: {e}")
        raise HTTPException(status_code=500, detail="Failed to register pass.")


@app.post("/api/conductor/passes/{pass_id}/cancel")
def cancel_conductor_pass(pass_id: int):
    try:
        passenger_pass = etm_db.cancel_pass(pass_id)
        if not passenger_pass:
            raise HTTPException(status_code=404, detail=f"Pass #{pass_id} not found.")
        summary = etm_db.get_ticketing_summary(
            passenger_pass["bus_id"],
            passenger_pass["trip_id"],
            passenger_pass["route"],
        )
        return {"success": True, "pass": passenger_pass, "summary": summary}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling pass: {e}")
        raise HTTPException(status_code=500, detail="Failed to cancel pass.")


@app.get("/api/conductor/ticketing/summary")
def get_conductor_ticketing_summary(
    bus_id: str = Query(..., min_length=1, max_length=50),
    trip_id: str = Query(..., min_length=1, max_length=50),
    route: Optional[str] = Query(""),
):
    try:
        summary = etm_db.get_ticketing_summary(bus_id, trip_id, route or "")
        return {"success": True, "summary": summary}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error fetching ticketing summary: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve ticketing summary.")


@app.get("/api/analytics/passengers")
def get_passenger_analytics(
    days: int = Query(7, ge=1, le=365),
    route: Optional[str] = Query(None),
):
    try:
        analytics = etm_db.get_passenger_analytics(days=days, route=route)
        return {"success": True, "analytics": analytics}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error building passenger analytics: {e}")
        raise HTTPException(status_code=500, detail="Failed to build passenger analytics.")


# ---------------------------------------------------------------------------
# Checker dispatch and inspection endpoints
# ---------------------------------------------------------------------------


@app.get("/api/checkers")
def get_checkers():
    try:
        checkers = alert_dispatch.list_checkers()
        return {"success": True, "checkers": checkers, "count": len(checkers)}
    except Exception as e:
        logger.error(f"Error fetching checkers: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve checkers.")


@app.get("/api/checker-dispatches")
def get_checker_dispatches(
    bus_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
):
    try:
        dispatches = alert_dispatch.list_dispatches(bus_id=bus_id, status=status, limit=limit)
        return {"success": True, "dispatches": dispatches, "count": len(dispatches)}
    except Exception as e:
        logger.error(f"Error fetching dispatches: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve dispatches.")


@app.post("/api/checker-dispatches", status_code=201)
def create_checker_dispatch(payload: DispatchRequest):
    try:
        dispatch = alert_dispatch.create_manual_dispatch(
            bus_id=payload.bus_id,
            checker_id=payload.checker_id,
            location=payload.location or "",
            checkpoint=payload.checkpoint or "",
            notes=payload.notes or "",
            alert_id=payload.alert_id,
            route=payload.route or "",
            trip_id=payload.trip_id or "",
        )
        return {"success": True, "dispatch": dispatch}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error creating checker dispatch: {e}")
        raise HTTPException(status_code=500, detail="Failed to create checker dispatch.")


@app.post("/api/checker-dispatches/{dispatch_id}/complete")
def complete_checker_dispatch(dispatch_id: int, payload: DispatchCompletionRequest):
    try:
        dispatch = alert_dispatch.complete_dispatch(
            dispatch_id=dispatch_id,
            outcome=payload.outcome,
            notes=payload.notes or "",
            mismatch_confirmed=payload.mismatch_confirmed,
        )
        if not dispatch:
            raise HTTPException(status_code=404, detail=f"Dispatch #{dispatch_id} not found.")
        return {"success": True, "dispatch": dispatch}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error completing checker dispatch: {e}")
        raise HTTPException(status_code=500, detail="Failed to complete checker dispatch.")


@app.get("/api/inspections")
def get_inspections(
    bus_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
):
    try:
        inspections = alert_dispatch.list_inspections(limit=limit, bus_id=bus_id, status=status)
        return {"success": True, "inspections": inspections, "count": len(inspections)}
    except Exception as e:
        logger.error(f"Error fetching inspections: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve inspection history.")


# ---------------------------------------------------------------------------
# Mismatch Alerts API endpoints
# ---------------------------------------------------------------------------


@app.get("/api/alerts")
@app.get("/api/mismatch-alerts")
def get_mismatch_alerts(
    bus_id: Optional[str] = Query(None),
    route: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(100),
):
    try:
        alerts = alert_dispatch.list_alerts(
            bus_id=bus_id,
            route=route,
            severity=severity,
            status=status,
            limit=limit,
        )
        return {"success": True, "alerts": alerts, "count": len(alerts)}
    except Exception as e:
        logger.error(f"Error fetching mismatch alerts: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve mismatch alerts.")


@app.get("/api/alerts/{alert_id}")
@app.get("/api/mismatch-alerts/{alert_id}")
def get_mismatch_alert(alert_id: int):
    try:
        alert = alert_dispatch.get_alert_by_id(alert_id)
        if not alert:
            raise HTTPException(status_code=404, detail=f"Alert #{alert_id} not found.")
        return {"success": True, "alert": alert}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching mismatch alert: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve mismatch alert.")


class AlertStatusUpdate(BaseModel):
    status: str = Field(..., description="New / Under Review / Resolved")


@app.put("/api/alerts/{alert_id}/status")
@app.post("/api/alerts/{alert_id}/status")
@app.put("/api/mismatch-alerts/{alert_id}/status")
@app.post("/api/mismatch-alerts/{alert_id}/status")
def update_mismatch_alert_status(alert_id: int, payload: AlertStatusUpdate):
    try:
        alert = alert_dispatch.update_alert_status(alert_id, payload.status)
        if not alert:
            raise HTTPException(status_code=404, detail=f"Alert #{alert_id} not found.")
        return {"success": True, "alert": alert}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating mismatch alert status: {e}")
        raise HTTPException(status_code=500, detail="Failed to update mismatch alert status.")


@app.put("/api/alerts/{alert_id}/resolve")
@app.post("/api/alerts/{alert_id}/resolve")
@app.put("/api/mismatch-alerts/{alert_id}/resolve")
def resolve_mismatch_alert(alert_id: int):
    try:
        alert = alert_dispatch.update_alert_status(alert_id, "Resolved")
        if not alert:
            raise HTTPException(status_code=404, detail=f"Alert #{alert_id} not found.")
        return {"success": True, "alert": alert}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error resolving mismatch alert: {e}")
        raise HTTPException(status_code=500, detail="Failed to resolve mismatch alert.")


@app.put("/api/alerts/{alert_id}/review")
@app.post("/api/alerts/{alert_id}/review")
@app.put("/api/mismatch-alerts/{alert_id}/review")
def review_mismatch_alert(alert_id: int):
    try:
        alert = alert_dispatch.update_alert_status(alert_id, "Under Review")
        if not alert:
            raise HTTPException(status_code=404, detail=f"Alert #{alert_id} not found.")
        return {"success": True, "alert": alert}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reviewing mismatch alert: {e}")
        raise HTTPException(status_code=500, detail="Failed to review mismatch alert.")


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 8001))
    logger.info(f"Starting SMART ST Vision server on http://{host}:{port}")
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
