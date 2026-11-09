from app import db
from app.workspace import use_workspace
from api_client import register_authenticated_client
from test_document_artifacts_api import api


def test_exports_queue_without_inline_execution_and_status_reads_are_passive(api):
    client, _, payload = api
    doc = client.post('/conversations/1/documents', json=payload).json()
    path = f"/documents/{doc['document_id']}/versions/1/exports"
    assert client.get('/document-export-capabilities').status_code == 200
    assert client.get(path).json() == {'exports': []}
    response = client.post(path, json={'format': 'pdf'})
    assert response.status_code == 202, response.text
    queued = response.json()
    assert queued['job']['status'] == 'queued' and queued['artifact'] is None
    assert 'owner_token' not in queued['job'] and 'snapshot' not in queued['job']
    assert client.post(path, json={'format': 'pdf'}).json()['job']['id'] == queued['job']['id']
    assert client.get(path).json()['exports'][0]['job']['id'] == queued['job']['id']
    assert response.headers['cache-control'] == 'no-store'
    assert client.post(path, json={'format':'html'}).status_code == 422
    with use_workspace(1), db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM file_artifacts').fetchone()[0] == 0


def test_export_endpoints_never_accept_other_account_document_ids(api):
    client, app, payload = api
    doc = client.post('/conversations/1/documents', json=payload).json()
    other = register_authenticated_client(app, email='other-export-owner@example.test')
    path = f"/documents/{doc['document_id']}/versions/1/exports"
    assert other.get(path).status_code == 404
    assert other.post(path, json={'format':'pdf'}).status_code == 404
