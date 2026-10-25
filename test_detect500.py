from backend.main import app
from fastapi.testclient import TestClient
import base64
import numpy as np
import cv2

c = TestClient(app)
img = np.zeros((480, 640, 3), dtype=np.uint8)
cv2.rectangle(img, (100, 50), (250, 400), (200, 200, 200), -1)
_, buffer = cv2.imencode('.jpg', img)
b64 = 'data:image/jpeg;base64,' + base64.b64encode(buffer).decode('utf-8')

payload = {'image': b64, 'track': True, 'bus_id': 'MH-12-QW-4821'}
try:
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.text)
except Exception as e:
    import traceback
    traceback.print_exc()
