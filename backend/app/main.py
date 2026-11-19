import csv
import hashlib
import hmac
import io
import os
import re
import secrets
import shutil
import sqlite3
import stat
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB_PATH = Path(os.getenv('DB_PATH', '/app/state/reader.db'))
DATA_BASE = Path(os.getenv('DATA_BASE_DIR', '/data')).resolve()
IMPORT_ROOT = DB_PATH.parent / 'datasets'
ADMIN_USER = os.getenv('ADMIN_USER', 'admin')
ALLOWED_ORIGINS = os.getenv('ALLOWED_ORIGINS', '')
app = FastAPI(title='Synthetic MRI Reader', version='0.1.0')
if ALLOWED_ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=[x.strip() for x in ALLOWED_ORIGINS.split(',')], allow_methods=['GET','POST','PUT','DELETE'], allow_headers=['Authorization','Content-Type'])


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def password_hash(password: str):
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 390000)
    return f'{salt.hex()}:{derived.hex()}'


def password_check(password: str, encoded: str):
    try:
        salt, expected = encoded.split(':')
        candidate = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 390000)
        return hmac.compare_digest(candidate, bytes.fromhex(expected))
    except (ValueError, TypeError):
        return False


@contextmanager
def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys=ON')
    connection.execute('PRAGMA busy_timeout=20000')
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_database():
    with db() as conn:
        conn.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','reader')), created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS evaluations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, reader_id TEXT NOT NULL, dataset_version INTEGER NOT NULL,
          case_id TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('accept','reject')),
          submitted_at TEXT NOT NULL, UNIQUE(reader_id,dataset_version,case_id),
          FOREIGN KEY(reader_id) REFERENCES users(id));
        ''')
        conn.execute("INSERT OR IGNORE INTO settings VALUES ('dataset_version','0')")


@app.on_event('startup')
def on_startup():
    init_database()


class Login(BaseModel):
    user_id: str
    password: str


class AdminSetup(BaseModel):
    password: str = Field(min_length=12, max_length=256)


class PasswordChange(AdminSetup):
    current_password: str


class ReaderCreate(BaseModel):
    user_id: str = Field(min_length=3,max_length=50,pattern=r'^[A-Za-z0-9_-]+$')
    password: str = Field(min_length=10,max_length=256)


class Configure(BaseModel):
    folder: str = Field(min_length=1)


class ImportDataset(BaseModel):
    folder: str = Field(min_length=1, max_length=255)
    files: int = Field(gt=0)


class Verdict(BaseModel):
    case_id: str
    verdict: str
    dataset_version: int


def get_user(authorization: Annotated[str | None, Header()] = None):
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(401,'Authentication required')
    token_hash = hashlib.sha256(authorization[7:].encode()).hexdigest()
    with db() as conn:
        user = conn.execute('SELECT users.id, users.role FROM users JOIN sessions ON users.id=sessions.user_id WHERE sessions.token_hash=?',(token_hash,)).fetchone()
    if not user:
        raise HTTPException(401,'Invalid session')
    return dict(user)


def admin(user=Depends(get_user)):
    if user['role'] != 'admin':
        raise HTTPException(403,'Admin access required')
    return user


def reader(user=Depends(get_user)):
    if user['role'] != 'reader':
        raise HTTPException(403,'Reader access required')
    return user


@app.get('/api/setup')
def setup_status():
    with db() as conn:
        exists = conn.execute("SELECT 1 FROM users WHERE role='admin'").fetchone()
    return {'required': exists is None, 'user_id': ADMIN_USER}


@app.post('/api/setup', status_code=201)
def setup_admin(body: AdminSetup):
    encoded = password_hash(body.password)
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if conn.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
            raise HTTPException(409, 'Admin setup is already complete')
        conn.execute('INSERT INTO users VALUES (?,?,?,?)', (ADMIN_USER, encoded, 'admin', utc_now()))
    return {'user_id': ADMIN_USER}


@app.put('/api/admin/password')
def change_admin_password(
    body: PasswordChange, authorization: Annotated[str, Header()], user=Depends(admin),
):
    with db() as conn:
        previous = conn.execute('SELECT password_hash FROM users WHERE id=?', (user['id'],)).fetchone()
    if not password_check(body.current_password, previous['password_hash']):
        raise HTTPException(400, 'Incorrect current password')
    if hmac.compare_digest(body.current_password.encode(), body.password.encode()):
        raise HTTPException(400, 'Choose a different password')
    token_hash = hashlib.sha256(authorization[7:].encode()).hexdigest()
    with db() as conn:
        updated = conn.execute(
            'UPDATE users SET password_hash=? WHERE id=? AND password_hash=?',
            (password_hash(body.password), user['id'], previous['password_hash']),
        )
        if not updated.rowcount:
            raise HTTPException(409, 'Password already changed. Sign in again')
        conn.execute('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', (user['id'], token_hash))
    return {'ok': True}


@app.post('/api/login')
def login(body: Login):
    with db() as conn:
        user = conn.execute('SELECT * FROM users WHERE id=?',(body.user_id,)).fetchone()
        if not user or not password_check(body.password, user['password_hash']):
            raise HTTPException(401, 'Invalid credentials')
        token = secrets.token_urlsafe(48)
        session = conn.execute(
            'INSERT INTO sessions SELECT ?,id,? FROM users WHERE id=? AND password_hash=?',
            (hashlib.sha256(token.encode()).hexdigest(), utc_now(), user['id'], user['password_hash']),
        )
        if not session.rowcount:
            raise HTTPException(401, 'Invalid credentials')
        return {'token':token,'user_id':user['id'],'role':user['role']}


@app.post('/api/logout')
def logout(authorization: Annotated[str | None, Header()] = None, user=Depends(get_user)):
    with db() as conn:
        conn.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(authorization[7:].encode()).hexdigest(),))
    return {'ok':True}


@app.get('/api/me')
def me(user=Depends(get_user)):
    return user


@app.post('/api/admin/readers')
def create_reader(body: ReaderCreate, user=Depends(admin)):
    with db() as conn:
        try:
            conn.execute('INSERT INTO users VALUES (?,?,?,?)',(body.user_id,password_hash(body.password),'reader',utc_now()))
        except sqlite3.IntegrityError:
            raise HTTPException(409,'Reader ID already exists')
    return {'user_id':body.user_id}


def scan_cases(folder: Path):
    cases = {}
    try:
        with os.scandir(folder) as entries:
            subfolders = [entry for entry in entries if entry.is_dir(follow_symlinks=False)]
    except (FileNotFoundError, NotADirectoryError):
        return cases
    for sub in sorted(subfolders, key=lambda entry: natural_key(entry.name)):
        try:
            with os.scandir(sub.path) as entries:
                slices = [
                    entry.name for entry in entries
                    if entry.name.lower().endswith('.png') and entry.name.lower() != '.png'
                    and entry.is_file(follow_symlinks=False)
                ]
        except (FileNotFoundError, NotADirectoryError):
            continue
        if slices:
            cases[sub.name] = sorted(slices, key=natural_key)
    return cases


def natural_key(string):
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r'(\d+)',string)]


def get_configuration():
    with db() as conn:
        settings = {r['name']:r['value'] for r in conn.execute('SELECT name,value FROM settings')}
    folder = settings.get('dataset_folder','')
    return folder, int(settings.get('dataset_version','0')), settings.get('dataset_import', '')


def folder_path(relative):
    if not relative or Path(relative).is_absolute():
        raise HTTPException(400, 'Use a relative folder within the configured data mount')
    path=(DATA_BASE/relative).resolve()
    if not path.is_relative_to(DATA_BASE) or not path.is_dir():
        raise HTTPException(400,'Folder does not exist within the data mount')
    return path


@app.get('/api/admin/settings')
def settings(user=Depends(admin)):
    folder, version, imported = get_configuration()
    cases = scan_cases(configured_path(folder, imported)) if folder else {}
    return {'folder': folder, 'dataset_version': version, 'cases': len(cases), 'source': 'import' if imported else 'mount'}


def configured_path(folder, imported):
    return IMPORT_ROOT / imported if imported else folder_path(folder)


def save_configuration(folder, cases, imported=''):
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        current = conn.execute("SELECT value FROM settings WHERE name='dataset_version'").fetchone()
        version = int(current['value']) + 1
        conn.executemany(
            'INSERT INTO settings(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
            [('dataset_folder', folder), ('dataset_version', str(version)), ('dataset_import', imported)],
        )
    return {'folder': folder, 'dataset_version': version, 'cases': len(cases), 'source': 'import' if imported else 'mount'}


@app.put('/api/admin/settings')
def configure(body: Configure,user=Depends(admin)):
    path=folder_path(body.folder)
    cases=scan_cases(path)
    if not cases:
        raise HTTPException(400,'Folder must contain case subfolders with PNG images')
    return save_configuration(body.folder, cases)


def staging_path(upload_id, user):
    owner = hashlib.sha256(user['id'].encode()).hexdigest()
    return IMPORT_ROOT / 'staging' / owner / str(upload_id)


@app.post('/api/admin/imports')
def begin_import(user=Depends(admin)):
    upload_id = UUID(bytes=secrets.token_bytes(16), version=4)
    staging_path(upload_id, user).mkdir(parents=True)
    return {'upload_id': str(upload_id)}


def valid_name(name):
    return name not in ('', '.', '..') and Path(name).name == name and not any(c in name for c in '/\\\x00') and len(name.encode()) <= 255


@app.put('/api/admin/imports/{upload_id}/slice')
async def upload_slice(upload_id: UUID, case: str, filename: str, request: Request, user=Depends(admin)):
    if not valid_name(case) or not valid_name(filename) or Path(filename).suffix.lower() != '.png':
        raise HTTPException(400, 'Expected a PNG directly inside a case folder')
    stage = staging_path(upload_id, user)
    if not stage.is_dir():
        raise HTTPException(404, 'Import not found')
    # Keep partial writes outside the dataset, so finalization only sees completed slices.
    file = tempfile.NamedTemporaryFile(dir=IMPORT_ROOT, delete=False)
    temporary = Path(file.name)
    try:
        with file:
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > 64 * 1024 * 1024:
                    raise HTTPException(413, 'PNG exceeds the 64 MiB limit')
                file.write(chunk)
        with temporary.open('rb') as image_file:
            if image_file.read(8) != b'\x89PNG\r\n\x1a\n':
                raise HTTPException(400, 'Invalid PNG')
        target = stage / case
        target.mkdir(exist_ok=True)
        temporary.replace(target / filename)
    except FileNotFoundError:
        raise HTTPException(404, 'Import not found')
    finally:
        temporary.unlink(missing_ok=True)
    return {'ok': True}


@app.post('/api/admin/imports/{upload_id}/finish')
def finish_import(upload_id: UUID, body: ImportDataset, user=Depends(admin)):
    stage = staging_path(upload_id, user)
    destination = IMPORT_ROOT / str(upload_id)
    try:
        stage.rename(destination)
    except OSError:
        raise HTTPException(409, 'Import is no longer open')
    try:
        cases = scan_cases(destination)
        if sum(map(len, cases.values())) != body.files:
            raise HTTPException(400, 'Dataset upload is incomplete')
        return save_configuration(body.folder, cases, str(upload_id))
    except Exception:
        shutil.rmtree(destination)
        raise


@app.delete('/api/admin/imports/{upload_id}')
def cancel_import(upload_id: UUID, user=Depends(admin)):
    shutil.rmtree(staging_path(upload_id, user), ignore_errors=True)
    return {'ok': True}


def active_cases():
    folder, version, imported = get_configuration()
    if not folder:
        return {},version
    try:
        return scan_cases(configured_path(folder, imported)),version
    except HTTPException:
        return {},version


@app.get('/api/reader/next')
def next_case(user=Depends(reader)):
    cases,version=active_cases()
    with db() as conn:
        completed={r['case_id'] for r in conn.execute('SELECT case_id FROM evaluations WHERE reader_id=? AND dataset_version=?',(user['id'],version))}
    next_id=next((case_id for case_id in cases if case_id not in completed),None)
    return {'done':next_id is None,'case_id':next_id,'slices':cases.get(next_id,[]),'dataset_version':version,'completed':len(completed & cases.keys()),'total':len(cases)}


@app.get('/api/reader/image/{case_id}/{filename}')
def image(case_id: str, filename: str, user=Depends(reader), version: Annotated[int | None, Query()] = None):
    folder, current_version, imported = get_configuration()
    if version is not None and version != current_version:
        raise HTTPException(409, 'Dataset changed. Reload and continue')
    if not folder or not valid_name(case_id) or not valid_name(filename) or Path(filename).suffix.lower() != '.png':
        raise HTTPException(404, 'Image not found')
    try:
        case = configured_path(folder, imported) / case_id
        if case.is_symlink():
            raise HTTPException(404)
        path = case / filename
        metadata = path.lstat()
    except (HTTPException, FileNotFoundError, NotADirectoryError):
        raise HTTPException(404, 'Image not found')
    if not stat.S_ISREG(metadata.st_mode):
        raise HTTPException(404, 'Image not found')
    return FileResponse(path, media_type='image/png', stat_result=metadata, headers={
        'Cache-Control': 'private, max-age=300',
        'Vary': 'Authorization',
        'X-Content-Type-Options': 'nosniff',
    })


@app.post('/api/reader/evaluate')
def evaluate(body:Verdict,user=Depends(reader)):
    if body.verdict not in ('accept','reject'):
        raise HTTPException(422,'Verdict must be accept or reject')
    cases,version=active_cases()
    if body.dataset_version != version:
        raise HTTPException(409,'Dataset changed. Reload and continue')
    if body.case_id not in cases:
        raise HTTPException(404,'Unknown case')
    with db() as conn:
        try:
            conn.execute('INSERT INTO evaluations(reader_id,dataset_version,case_id,verdict,submitted_at) VALUES (?,?,?,?,?)',(user['id'],version,body.case_id,body.verdict,utc_now()))
        except sqlite3.IntegrityError:
            raise HTTPException(409,'Case already evaluated')
    return {'ok':True}


@app.get('/api/admin/results')
def results(user=Depends(admin)):
    with db() as conn:
        rows=conn.execute('SELECT reader_id,dataset_version,case_id,verdict,submitted_at FROM evaluations ORDER BY submitted_at DESC,id DESC').fetchall()
        readers=conn.execute("SELECT id FROM users WHERE role='reader' ORDER BY id").fetchall()
    cases,version=active_cases()
    return {'rows':[dict(r) for r in rows], 'readers':[r['id'] for r in readers], 'current_version':version, 'current_cases':len(cases)}


@app.get('/api/admin/export.csv')
def export(user=Depends(admin)):
    with db() as conn:
        rows=conn.execute('SELECT reader_id,dataset_version,case_id,verdict,submitted_at FROM evaluations ORDER BY dataset_version,reader_id,case_id').fetchall()
    output=io.StringIO()
    writer=csv.writer(output)
    writer.writerow(['reader_id','dataset_version','case_id','verdict','submitted_at_utc'])
    writer.writerows([list(row) for row in rows])
    return StreamingResponse(iter([output.getvalue()]),media_type='text/csv; charset=utf-8',headers={'Content-Disposition':'attachment; filename="mri_evaluations.csv"'})


@app.get('/api/health')
def health():
    return {'ok':True}
