from backend.main import app, yolo_model, load_model
from fastapi.testclient import TestClient
import base64
from ultralytics import YOLO
import os

# Fresh start
if yolo_model is None:
    load_model()

c = TestClient(app)
r = c.get('/api/sample-frame')
data = r.json()
payload = {'image': data['image'], 'track': True, 'bus_id': 'MH-12-QW-4821'}
try:
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.text[:150])
except Exception as e:
    import traceback
    traceback.print_exc()
