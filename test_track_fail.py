from backend.main import app, yolo_model
from fastapi.testclient import TestClient
import numpy as np
import cv2
import base64

c = TestClient(app)
# Get sample frame
r = c.get('/api/sample-frame')
data = r.json()
img_b64 = data['image']
# Send multiple times rapidly like the frontend does
payload = {'image': img_b64, 'track': True, 'bus_id': 'MH-12-QW-4821'}
for i in range(5):
    try:
        res = c.post('/api/detect', json=payload)
        print(f'{i}: {res.status_code}')
        if res.status_code != 200:
            print(res.text)
    except Exception as e:
        import traceback
        traceback.print_exc()
        break
