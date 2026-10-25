from backend.main import app
from fastapi.testclient import TestClient
from backend import conductor_db

c = TestClient(app)
# Simulate monitoring page sending detection
r = c.get('/api/sample-frame')
data = r.json()
payload = {'image': data['image'], 'track': True, 'bus_id': 'MH-12-QW-4821'}
res = c.post('/api/detect', json=payload)
print(res.status_code, res.json()['count'])

# Conductor panel checks camera state
res2 = c.get('/api/conductor/camera-state?bus_id=MH-12-QW-4821')
print(res2.status_code)
print(res2.json()['count'], res2.json()['status'])
