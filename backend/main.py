"""
SMART ST Control Center - Real-Time Person Detection & Passenger Counting Service
Powered by FastAPI, OpenCV, and Ultralytics YOLOv8 (COCO Person Class 0)
"""

import os
import sys
import time
import base64
import logging
from typing import List, Optional, Any
from datetime import datetime, timezone

try:
    import numpy as np
except ImportError:
    np = None

try:
    import cv2
except ImportError:
    cv2 = None

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, StrictInt

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
        ".env"
    ]
    for p in env_paths:
        if os.path.exists(p):
            load_dotenv(p)
            break
except ImportError:
    pass

# Documented backend default confidence threshold for YOLO person detection
DEFAULT_YOLO_CONFIDENCE_THRESHOLD: float = 0.70

try:
    from backend import conductor_db
except ImportError:
    import conductor_db



def get_yolo_confidence_threshold() -> float:
    """
    Reads and validates the YOLO confidence threshold from the environment variable
    YOLO_CONFIDENCE_THRESHOLD. Valid range: 0.01 to 0.99.
    Falls back to documented backend default (0.70) if not set or invalid.
    """
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


# Initialize FastAPI app
app = FastAPI(
    title="SMART ST Vision API",
    description="Browser camera frame inference for real-time person detection & passenger monitoring using YOLO and OpenCV",
    version="1.0.0"
)

# Configure CORS for Vite development server (localhost:5173) and any local network access
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
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


def find_model_path():
    """Finds yolov8n.pt in common locations."""
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
    return "yolov8n.pt"  # Will fallback to ultralytics download/cache if not found locally


def load_model():
    """Loads the pretrained YOLO model with error handling and warmup."""
    global yolo_model, model_device
    try:
        from ultralytics import YOLO
        import torch

        model_device = "cuda" if torch.cuda.is_available() else "cpu"
        model_file = find_model_path()
        logger.info(f"Loading YOLO model from '{model_file}' on device '{model_device}'...")

        yolo_model = YOLO(model_file)
        
        # Warmup model with a dummy blank image using configured confidence
        active_conf = get_yolo_confidence_threshold()
        if np is not None:
            warmup_img = np.zeros((320, 320, 3), dtype=np.uint8)
            yolo_model(warmup_img, classes=[0], conf=active_conf, verbose=False)
        logger.info(
            f"YOLO model successfully loaded and warmed up! "
            f"Target class: Person (ID 0). Backend confidence threshold: {active_conf}."
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
    load_model()


# Pydantic Schemas
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
    # Note: confidence is backend-controlled via YOLO_CONFIDENCE_THRESHOLD and cannot be overridden by request parameters
    confidence: Optional[float] = Field(None, description="Ignored: Backend controls threshold via YOLO_CONFIDENCE_THRESHOLD")
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
def health_check():
    """Returns the service health status, model readiness, compute device, and backend confidence threshold."""
    global yolo_model
    if yolo_model is None:
        load_model()
    return {
        "status": "healthy" if yolo_model is not None else "degraded",
        "model_loaded": yolo_model is not None,
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
        return {"success": True, "image": b64, "name": "COCO bus.jpg (3 passengers visible)"}
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
    Primary real-time detection endpoint.
    Receives camera frame from browser, decodes with OpenCV,
    and runs YOLO inference filtering exclusively for the COCO person class (0).
    Confidence threshold is strictly backend-configured (cannot be overridden by frontend).
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

    # Step 2: Run YOLO inference for COCO person class (0) using backend confidence threshold
    conf_threshold = get_yolo_confidence_threshold()
    t_inf_start = time.perf_counter()
    try:
        if payload.track:
            # Persistent multi-object tracking (ByteTrack)
            results = yolo_model.track(
                img,
                classes=[0],
                conf=conf_threshold,
                iou=payload.iou,
                persist=True,
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
        logger.error(f"Inference error: {e}")
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")

    inference_time_ms = round((time.perf_counter() - t_inf_start) * 1000, 2)

    # Step 3: Extract structured bounding boxes
    detections: List[BoundingBox] = []
    if len(results) > 0 and results[0].boxes is not None:
        boxes = results[0].boxes
        for box in boxes:
            coords = box.xyxy[0].cpu().numpy().tolist()
            x1, y1, x2, y2 = [float(c) for c in coords]
            conf = float(box.conf[0].cpu().numpy())
            cls_id = int(box.cls[0].cpu().numpy())
            track_id = int(box.id[0].cpu().numpy()) if (payload.track and box.id is not None) else None

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

    # Record latest detection in persistent storage for conductor comparison
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
    """Resets the tracker states so new tracking sessions start with fresh IDs."""
    global yolo_model
    if yolo_model is not None and hasattr(yolo_model, "predictor") and yolo_model.predictor is not None:
        if hasattr(yolo_model.predictor, "trackers"):
            yolo_model.predictor.trackers = []
    return {"success": True, "message": "Tracker history cleared"}


# =====================================================================
# Conductor Panel Models and Endpoints
# =====================================================================

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
    bus_id: str = Field(..., min_length=1, max_length=50, description="Bus registration ID, e.g. MH-12-QW-4821")
    route: str = Field(..., min_length=1, max_length=100, description="Route, e.g. Pune – Mumbai")
    trip_id: str = Field(..., min_length=1, max_length=50, description="Trip identifier, e.g. TRIP-1042-01")
    checkpoint: str = Field(..., min_length=1, max_length=100, description="Current checkpoint, e.g. Lonavala Bus Stand")
    conductor_id: Optional[str] = Field("", max_length=100, description="Conductor name or ID")
    active_tickets: StrictInt = Field(..., ge=0, le=500, description="Active tickets validated at checkpoint")
    valid_passes: StrictInt = Field(..., ge=0, le=500, description="Valid passenger passes at checkpoint")
    other_authorized: Optional[StrictInt] = Field(0, ge=0, le=500, description="Other authorized passengers")
    starting_onboard: StrictInt = Field(..., ge=0, le=500, description="Passengers onboard at start of counting period")
    boarded: Optional[StrictInt] = Field(0, ge=0, le=500, description="Passengers boarded during period")
    alighted: Optional[StrictInt] = Field(0, ge=0, le=500, description="Passengers alighted during period")
    notes: Optional[str] = Field("", max_length=500, description="Operational notes (no personal passenger data)")
    camera_estimate: Optional[StrictInt] = Field(None, ge=0, le=500, description="Optional explicit camera estimate snapshot")
    camera_detection_time: Optional[str] = Field("", max_length=100, description="Timestamp of camera detection snapshot")


class CheckpointSubmissionResponse(BaseModel):
    success: bool
    id: int
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
    comparison_status: str
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
            camera_detection_time=payload.camera_detection_time
        )
        return CheckpointSubmissionResponse(success=True, **saved)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error persisting checkpoint submission: {e}")
        raise HTTPException(status_code=500, detail="Failed to persist checkpoint record.")


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






if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting SMART ST Vision server on http://{host}:{port}")
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
