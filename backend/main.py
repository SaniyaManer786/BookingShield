"""
SMART ST Control Center - Real-Time Person Detection & Passenger Counting Service
Powered by FastAPI, OpenCV, and Ultralytics YOLOv8 (COCO Person Class 0)
"""

import os
import sys
import time
import base64
import logging
from typing import List, Optional
from datetime import datetime, timezone
import numpy as np
import cv2
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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


def decode_base64_image(image_str: str) -> np.ndarray:
    """Decodes a base64 string or data URL into an OpenCV BGR image."""
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


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting SMART ST Vision server on http://{host}:{port}")
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)
