import base64
import numpy as np
import cv2
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

# 1. Test health check
health = client.get("/api/health")
print("Health status code:", health.status_code, health.json())

# 2. Test detect endpoint with a generated frame
img = np.zeros((480, 640, 3), dtype=np.uint8)
# Add some visual shapes
cv2.circle(img, (320, 240), 50, (200, 200, 200), -1)

_, buffer = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
b64_str = "data:image/jpeg;base64," + base64.b64encode(buffer).decode("utf-8")

payload = {
    "image": b64_str,
    "confidence": 0.3,
    "track": False
}

detect_res = client.post("/api/detect", json=payload)
print("Detect status code:", detect_res.status_code)
data = detect_res.json()
print("Detect response:", {
    "success": data.get("success"),
    "count": data.get("count"),
    "width": data.get("image_width"),
    "height": data.get("image_height"),
    "inference_time_ms": data.get("inference_time_ms"),
    "total_processing_ms": data.get("total_processing_ms"),
    "device": data.get("device")
})
