import importlib
import os
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient


def test_full_reader_workflow():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        data = root / 'data'
        (data / 'cases' / 'Case_001').mkdir(parents=True)
        (data / 'cases' / 'Case_002').mkdir(parents=True)
        for case in ('Case_001', 'Case_002'):
            (data / 'cases' / case / 'slice_1.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        os.environ['DB_PATH'] = str(root / 'app.db')
        os.environ['DATA_BASE_DIR'] = str(data)
        os.environ['ADMIN_USER'] = 'admin'
        import app.main as main
        importlib.reload(main)
        with TestClient(main.app) as client:
            def request(method, url, token=None, **kwargs):
                if token:
                    kwargs['headers'] = {'Authorization': 'Bearer ' + token}
                return client.request(method, url, **kwargs)

            assert request('GET', '/api/setup').json()['required'] is True
            original = 'strong-test-admin-pass'
            assert request('POST', '/api/setup', json={'password': original}).status_code == 201
            assert request('POST', '/api/setup', json={'password': original}).status_code == 409
            assert request('GET', '/api/setup').json()['required'] is False
            login = {'user_id': 'admin', 'password': original}
            admin = request('POST', '/api/login', json=login).json()['token']
            other_session = request('POST', '/api/login', json=login).json()['token']
            updated = 'updated-test-admin-pass'
            assert request('PUT', '/api/admin/password', admin, json={'current_password': 'incorrect', 'password': updated}).status_code == 400
            assert request('PUT', '/api/admin/password', admin, json={'current_password': original, 'password': updated}).status_code == 200
            assert request('GET', '/api/me', other_session).status_code == 401
            assert request('POST', '/api/login', json=login).status_code == 401
            assert request('POST', '/api/login', json={**login, 'password': updated}).status_code == 200
            assert request('PUT','/api/admin/settings',admin,json={'folder':'cases'}).status_code == 200
            assert request('POST','/api/admin/readers',admin,json={'user_id':'RAD001','password':'reader-password'}).status_code == 200
            assert request('POST','/api/admin/readers',admin,json={'user_id':'RAD001','password':'reader-password'}).status_code == 409
            reader = request('POST', '/api/login', json={'user_id':'RAD001','password':'reader-password'}).json()['token']
            assert request('GET','/api/admin/results',reader).status_code == 403
            current = request('GET','/api/reader/next',reader).json()
            assert (current['case_id'],current['completed'],current['total']) == ('Case_001',0,2)
            assert request('GET','/api/reader/image/Case_001/slice_1.png',reader).status_code == 200
            payload = {'case_id':'Case_001','dataset_version':current['dataset_version'],'verdict':'accept'}
            assert request('POST','/api/reader/evaluate',reader,json=payload).status_code == 200
            assert request('POST','/api/reader/evaluate',reader,json=payload).status_code == 409
            current = request('GET','/api/reader/next',reader).json()
            assert current['case_id'] == 'Case_002'
            assert request('POST','/api/reader/evaluate',reader,json={**payload,'case_id':'Case_002','verdict':'reject'}).status_code == 200
            assert request('GET','/api/reader/next',reader).json()['done'] is True
            assert len(request('GET','/api/admin/results',admin).json()['rows']) == 2
            csv_body = request('GET','/api/admin/export.csv',admin).text
            assert 'RAD001' in csv_body and 'Case_002' in csv_body
