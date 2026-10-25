from backend.main import app
from fastapi.testclient import TestClient
import numpy as np
import cv2
import base64

c = TestClient(app)
r = c.get('/api/sample-frame')
data = r.json()
img_b64 = data['image']
# Simulate rapid different frames
for i in range(20):
    payload = {'image': img_b64, 'track': True, 'bus_id': 'MH-12-QW-4821'}
    try:
        res = c.post('/api/detect', json=payload)
        if res.status_code != 200:
            print(f'ERR {i}: {res.status_code} {res.text[:60]}')
            break
        print(f'{i}: ok')
    except Exception as e:
        import traceback
        traceback.print_exc()
        break
