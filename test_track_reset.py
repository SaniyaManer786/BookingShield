from backend.main import app
from fastapi.testclient import TestClient

c = TestClient(app)
# Reset tracker
r = c.post('/api/reset-tracker')
print(r.status_code)
# get sample
r = c.get('/api/sample-frame')
data = r.json()
payload = {'image': data['image'], 'track': True, 'bus_id': 'MH-12-QW-4821'}
try:
    res = c.post('/api/detect', json=payload)
    print(res.status_code)
    print(res.text[:100])
except Exception as e:
    import traceback
    traceback.print_exc()
