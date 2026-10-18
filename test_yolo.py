import cv2
import numpy as np
from ultralytics import YOLO

print("Loading YOLOv8n model...")
model = YOLO("yolov8n.pt")
print("Model loaded successfully. Person class ID:", 0, model.names[0])

# Test inference on dummy frame
dummy_frame = np.zeros((480, 640, 3), dtype=np.uint8)
# Draw a rectangle to simulate image
cv2.rectangle(dummy_frame, (50, 50), (200, 300), (255, 255, 255), -1)

results = model(dummy_frame, classes=[0], conf=0.25, verbose=False)
boxes = results[0].boxes
print(f"Inference test complete. Found {len(boxes)} person detections in blank frame.")
