"""Comprehensive test suite for FolhaPonto – covers auth, permissions, CPF, imports, processing, dispatches, archive, dashboard, and security."""

import csv
import io
import sqlite3
from pathlib import Path
from typing import Any

import fitz
import pytest
from fastapi.testclient import TestClient

import auth
import server
from FolhaPontoBack import processing
from security import display_cpf, mask_cpf, normalize_cpf, validate_cpf


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class AuthedClient:
    """Thin wrapper that injects an Authorization header into every request."""

    def __init__(self, client: TestClient, token: str):
        self._client = client
        self._token = token
        self._headers = {"Authorization": f"Bearer {token}"}

    def request(self, method: str, url: str, **kwargs: Any):
        headers = dict(self._headers)
        headers.update(kwargs.pop("headers", {}))
        return self._client.request(method, url, headers=headers, **kwargs)

    def get(self, url: str, **kwargs: Any):
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any):
        return self.request("POST", url, **kwargs)

    def __getattr__(self, name: str):
        return getattr(self._client, name)


def _three_page_pdf() -> bytes:
    doc = fitz.open()
    for _ in range(3):
        doc.new_page(width=300, height=400)
    return doc.tobytes()


def _text_pdf(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((30, 50), text)
    data = doc.tobytes()
    doc.close()
    return data


def _make_csv(rows: list[list[str]], sep: str = ",") -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=sep)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode("utf-8")


def _employee_csv_content() -> bytes:
    return _make_csv([
        ["Nome", "Matrícula", "CPF", "E-mail", "Carga Horária", "Acumula cargo (Sim/Não)"],
        ["João Silva", "100001", "11122233344", "joao@undf.edu.br", "40", "Não"],
    ])


def _employee_csv_content_acumula() -> bytes:
    return _make_csv([
        ["Nome", "Matrícula", "CPF", "E-mail", "Carga Horária", "Acumula cargo (Sim/Não)"],
        ["Maria Cargo", "100002", "55566677788", "maria@undf.edu.br", "40", "Sim"],
    ])


def _configure_auth(db_path: Path) -> None:
    """Wire auth callbacks so they read/write the test DB."""

    def fetch_user(user_id: int) -> dict[str, Any] | None:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id, username, role, full_name, active FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def is_revoked(token: str) -> bool:
        import hashlib
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT 1 FROM revoked_tokens WHERE token_hash = ?", (digest,)).fetchone()
        conn.close()
        return row is not None

    def revoke_token(token: str, user_id: int | None = None, expires_at=None) -> None:
        import hashlib
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "INSERT INTO revoked_tokens (token_hash, user_id, revoked_at) VALUES (?, ?, ?)",
            (digest, user_id, server.now()),
        )
        conn.commit()
        conn.close()

    auth.configure(fetch_user=fetch_user, is_revoked=is_revoked, revoke_token=revoke_token)


def _create_user(db_path: Path, username: str, password: str, role: str) -> None:
    """Insert a user directly into the DB for testing."""
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO users (username, password_hash, role, full_name, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        (username, auth.hash_password(password), role, username, server.now(), server.now()),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    """Fresh isolated DB per test, with admin user pre-seeded."""
    data_dir = tmp_path / "data"
    upload_dir = data_dir / "uploads"
    upload_dir.mkdir(parents=True)
    db_path = data_dir / "digep.sqlite3"

    monkeypatch.setattr(server, "DATA_DIR", data_dir)
    monkeypatch.setattr(server, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(server, "DB_PATH", db_path)

    # Prevent any real OCR from being attempted
    monkeypatch.setattr(processing, "_run_ocr", lambda _: ("", "ocr-indisponivel"))
    monkeypatch.setattr(processing, "_run_ocr_with_confidence", lambda _: ("", "ocr-indisponivel", {}))

    # Ensure ADMIN env vars are NOT set so init_db won't create an admin automatically
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)

    # Initialize DB tables (normally done inside app lifespan)
    server.init_db()

    _configure_auth(db_path)

    # Seed roles
    _create_user(db_path, "admin@test.com", "pass123", "admin")
    _create_user(db_path, "operador@test.com", "pass123", "operador")
    _create_user(db_path, "consulta@test.com", "pass123", "consulta")

    with TestClient(server.app, raise_server_exceptions=False) as c:
        yield c


def _login(client: TestClient, username: str, password: str) -> str:
    resp = client.post("/api/auth/login", json={"username": username, "password": password})
    return resp.json()["access_token"]


def _admin(client: TestClient) -> AuthedClient:
    return AuthedClient(client, _login(client, "admin@test.com", "pass123"))


def _operador(client: TestClient) -> AuthedClient:
    return AuthedClient(client, _login(client, "operador@test.com", "pass123"))


def _consulta(client: TestClient) -> AuthedClient:
    return AuthedClient(client, _login(client, "consulta@test.com", "pass123"))


def _upload_empty_pdf(ac: AuthedClient) -> dict:
    content = _three_page_pdf()
    resp = ac.post(
        "/api/batches",
        files={"file": ("blank.pdf", content, "application/pdf")},
    )
    return resp.json()


# ===================================================================
# 1. Authentication tests
# ===================================================================

class TestAuthentication:

    def test_login_valid_credentials(self, client):
        resp = client.post(
            "/api/auth/login",
            json={"username": "admin@test.com", "password": "pass123"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "access_token" in body
        assert body["token_type"] == "bearer"
        assert body["user"]["role"] == "admin"

    def test_login_invalid_password(self, client):
        resp = client.post(
            "/api/auth/login",
            json={"username": "admin@test.com", "password": "wrongpass"},
        )
        assert resp.status_code == 401

    def test_login_nonexistent_user(self, client):
        resp = client.post(
            "/api/auth/login",
            json={"username": "noone@test.com", "password": "pass123"},
        )
        assert resp.status_code == 401

    def test_access_protected_route_without_token(self, client):
        resp = client.get("/api/auth/me")
        assert resp.status_code in (401, 403)

    def test_access_protected_route_with_valid_token(self, client):
        ac = _admin(client)
        resp = ac.get("/api/auth/me")
        assert resp.status_code == 200
        assert resp.json()["username"] == "admin@test.com"

    def test_logout_revokes_token(self, client):
        ac = _admin(client)
        resp = ac.post("/api/auth/logout")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
        # Token should now be rejected
        resp2 = ac.get("/api/auth/me")
        assert resp2.status_code == 401


# ===================================================================
# 2. Permission tests
# ===================================================================

class TestPermissions:

    def test_operador_cannot_authorize_dispatch(self, client):
        ac_op = _operador(client)
        # First create a dispatch via admin
        ac_admin = _admin(client)
        batch_data = _upload_empty_pdf(ac_admin)
        ts_id = batch_data["timesheets"][0]["id"]
        # Import an employee with acumula_cargo so a dispatch is created
        ac_admin.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content_acumula(), "text/csv")},
        )
        preview_resp = ac_admin.post(
            "/api/employees/import/confirm",
            json={"preview_id": ac_admin.post(
                "/api/employees/import/preview",
                files={"file": ("emp.csv", _employee_csv_content_acumula(), "text/csv")},
            ).json()["preview_id"]},
        )
        # Archive with employee that has acumula_cargo
        import json
        emp_id = ac_admin.get("/api/employees").json()[0]["id"]
        ac_admin.post(
            f"/api/timesheets/{ts_id}/review",
            json={
                "name": "Maria Cargo",
                "matricula": "100002",
                "competencia": "07/2026",
                "employee_id": emp_id,
                "note": "",
            },
        )
        dispatches = ac_admin.get("/api/dispatches").json()
        assert len(dispatches) >= 1
        dispatch_id = dispatches[0]["id"]
        # Operador cannot authorize
        resp = ac_op.post(f"/api/dispatches/{dispatch_id}/authorize")
        assert resp.status_code == 403

    def test_consulta_cannot_upload_batch(self, client):
        ac_cons = _consulta(client)
        content = _three_page_pdf()
        resp = ac_cons.post(
            "/api/batches",
            files={"file": ("test.pdf", content, "application/pdf")},
        )
        assert resp.status_code == 403

    def test_admin_can_do_everything(self, client):
        ac = _admin(client)
        # Health
        assert ac.get("/api/health").status_code == 200
        # Me
        assert ac.get("/api/auth/me").status_code == 200
        # Employees list
        assert ac.get("/api/employees").status_code == 200
        # Timesheets list
        assert ac.get("/api/timesheets").status_code == 200
        # Dashboard
        assert ac.get("/api/dashboard").status_code == 200
        # Dispatches list
        assert ac.get("/api/dispatches").status_code == 200
        # Batch upload
        content = _three_page_pdf()
        resp = ac.post(
            "/api/batches",
            files={"file": ("admin.pdf", content, "application/pdf")},
        )
        assert resp.status_code == 200


# ===================================================================
# 3. CPF masking tests
# ===================================================================

class TestCPFMasking:

    def test_employees_endpoint_masks_cpf(self, client):
        ac = _admin(client)
        # Import an employee with a known CPF
        ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content(), "text/csv")},
        )
        preview = ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content(), "text/csv")},
        ).json()
        ac.post("/api/employees/import/confirm", json={"preview_id": preview["preview_id"]})
        employees = ac.get("/api/employees").json()
        assert len(employees) >= 1
        cpf = employees[0]["cpf"]
        # Must be masked, not full
        assert cpf == "***.***.***-44"

    def test_cpf_not_exposed_in_api(self, client):
        ac = _admin(client)
        ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content(), "text/csv")},
        )
        preview = ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content(), "text/csv")},
        ).json()
        ac.post("/api/employees/import/confirm", json={"preview_id": preview["preview_id"]})
        employees = ac.get("/api/employees").json()
        for emp in employees:
            # Full CPF "11122233344" must never appear
            assert "11122233344" not in str(emp)

    def test_validate_cpf_valid(self):
        # Known valid CPF
        assert validate_cpf("11144477735") is True

    def test_validate_cpf_invalid(self):
        assert validate_cpf("11111111111") is False
        assert validate_cpf("123") is False
        assert validate_cpf("") is False


# ===================================================================
# 4. Import tests
# ===================================================================

class TestImport:

    def test_csv_import_with_semicolon(self, client):
        ac = _admin(client)
        content = _make_csv([
            ["Nome", "Matrícula", "CPF", "E-mail", "Carga Horária", "Acumula cargo (Sim/Não)"],
            ["Carlos Teste", "200001", "11122233344", "carlos@undf.edu.br", "40", "Não"],
        ], sep=";")
        resp = ac.post(
            "/api/employees/import/preview",
            files={"file": ("servidores.csv", content, "text/csv")},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid_rows"] == 1
        # Confirm
        resp2 = ac.post("/api/employees/import/confirm", json={"preview_id": body["preview_id"]})
        assert resp2.status_code == 200
        assert resp2.json()["inserted"] == 1

    def test_invalid_cpf_in_import(self, client):
        ac = _admin(client)
        content = _make_csv([
            ["Nome", "Matrícula", "CPF", "E-mail", "Carga Horária", "Acumula cargo (Sim/Não)"],
            ["Sem CPF", "300001", "123", "a@b.com", "40", "Não"],
        ])
        resp = ac.post(
            "/api/employees/import/preview",
            files={"file": ("bad.csv", content, "text/csv")},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["invalid_rows"] == 1
        assert any("CPF" in e for e in body["errors"][0]["errors"])

    def test_duplicate_matricula_in_import(self, client):
        ac = _admin(client)
        content = _make_csv([
            ["Nome", "Matrícula", "CPF", "E-mail", "Carga Horária", "Acumula cargo (Sim/Não)"],
            ["Duplo A", "400001", "11122233344", "a@undf.edu.br", "40", "Não"],
            ["Duplo B", "400001", "55566677788", "b@undf.edu.br", "40", "Não"],
        ])
        resp = ac.post(
            "/api/employees/import/preview",
            files={"file": ("dup.csv", content, "text/csv")},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid_rows"] == 1
        assert body["invalid_rows"] == 1
        assert "duplicada" in body["errors"][0]["errors"][0].lower()


# ===================================================================
# 5. Processing tests
# ===================================================================

class TestProcessing:

    def test_pdf_three_pages(self, client):
        ac = _admin(client)
        content = _three_page_pdf()
        resp = ac.post(
            "/api/batches",
            files={"file": ("three.pdf", content, "application/pdf")},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["pages"] == 3
        assert len(body["timesheets"]) == 3

    def test_processing_with_text_content(self, tmp_path, monkeypatch):
        monkeypatch.setattr(processing, "_run_ocr", lambda _: ("", "ocr-indisponivel"))
        monkeypatch.setattr(processing, "_run_ocr_with_confidence", lambda _: ("", "ocr-indisponivel", {}))
        pdf = _text_pdf(
            "REGISTRO DE FREQUÊNCIA\n"
            "REFERÊNCIA: JULHO/2026\n"
            "MATRÍCULA: 17289106\n"
            "NOME DO SERVIDOR: ALEXANDRE NATA VICENTE"
        )
        source = tmp_path / "text.pdf"
        source.write_bytes(pdf)
        result = processing.process_document(source, tmp_path / "pages")
        assert result["pages"] == 1
        ext = result["page_results"][0]["extraction"]
        assert ext["matricula"] == "17289106"
        assert ext["nome"] == "ALEXANDRE NATA VICENTE"
        assert ext["competencia"] == "JULHO/2026"

    def test_ocr_indisponivel_when_no_tesseract(self, tmp_path, monkeypatch):
        monkeypatch.setattr(processing, "_run_ocr", lambda _: ("", "ocr-indisponivel"))
        monkeypatch.setattr(processing, "_run_ocr_with_confidence", lambda _: ("", "ocr-indisponivel", {}))
        result = processing.extract_fields("")
        assert result.modo == "ocr-indisponivel"
        assert result.matricula is None

    def test_classification_reconhecida(self):
        ext = processing.Extraction(
            matricula="12345",
            nome="TESTE",
            competencia="JULHO/2026",
            confianca=0.95,
            modo="ocr-texto",
            texto="x",
        )
        result = processing.classify_extraction(ext, employee_db={"12345": "TESTE"})
        assert result.status == "reconhecida"

    def test_classification_baixa_confianca(self):
        ext = processing.Extraction(
            matricula="12345",
            nome=None,
            competencia=None,
            confianca=0.45,
            modo="ocr-texto",
            texto="x",
        )
        result = processing.classify_extraction(ext)
        assert result.status == "baixa_confianca"


# ===================================================================
# 6. Dispatch tests
# ===================================================================

class TestDispatch:

    def test_dispatch_created_on_archive_with_acumula_cargo(self, client):
        ac = _admin(client)
        # Import employee with acumula_cargo
        preview = ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content_acumula(), "text/csv")},
        ).json()
        ac.post("/api/employees/import/confirm", json={"preview_id": preview["preview_id"]})
        # Upload batch
        batch = _upload_empty_pdf(ac)
        ts_id = batch["timesheets"][0]["id"]
        # Archive with employee
        emp_id = ac.get("/api/employees").json()[0]["id"]
        ac.post(
            f"/api/timesheets/{ts_id}/review",
            json={
                "name": "Maria Cargo",
                "matricula": "100002",
                "competencia": "07/2026",
                "employee_id": emp_id,
                "note": "",
            },
        )
        dispatches = ac.get("/api/dispatches").json()
        assert len(dispatches) >= 1
        assert dispatches[0]["status"] == "pendente"

    def test_dispatch_authorize(self, client):
        ac = _admin(client)
        preview = ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content_acumula(), "text/csv")},
        ).json()
        ac.post("/api/employees/import/confirm", json={"preview_id": preview["preview_id"]})
        batch = _upload_empty_pdf(ac)
        ts_id = batch["timesheets"][0]["id"]
        emp_id = ac.get("/api/employees").json()[0]["id"]
        ac.post(
            f"/api/timesheets/{ts_id}/review",
            json={
                "name": "Maria Cargo",
                "matricula": "100002",
                "competencia": "07/2026",
                "employee_id": emp_id,
                "note": "",
            },
        )
        dispatch_id = ac.get("/api/dispatches").json()[0]["id"]
        resp = ac.post(f"/api/dispatches/{dispatch_id}/authorize")
        assert resp.status_code == 200
        assert resp.json()["authorized_by"] is not None

    def test_dispatch_simulate_send_success(self, client):
        ac = _admin(client)
        preview = ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content_acumula(), "text/csv")},
        ).json()
        ac.post("/api/employees/import/confirm", json={"preview_id": preview["preview_id"]})
        batch = _upload_empty_pdf(ac)
        ts_id = batch["timesheets"][0]["id"]
        emp_id = ac.get("/api/employees").json()[0]["id"]
        ac.post(
            f"/api/timesheets/{ts_id}/review",
            json={
                "name": "Maria Cargo",
                "matricula": "100002",
                "competencia": "07/2026",
                "employee_id": emp_id,
                "note": "",
            },
        )
        dispatch_id = ac.get("/api/dispatches").json()[0]["id"]
        resp = ac.post(
            f"/api/dispatches/{dispatch_id}/simulate-send",
            json={"result": "success"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "enviado"

    def test_dispatch_simulate_send_error(self, client):
        ac = _admin(client)
        preview = ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content_acumula(), "text/csv")},
        ).json()
        ac.post("/api/employees/import/confirm", json={"preview_id": preview["preview_id"]})
        batch = _upload_empty_pdf(ac)
        ts_id = batch["timesheets"][0]["id"]
        emp_id = ac.get("/api/employees").json()[0]["id"]
        ac.post(
            f"/api/timesheets/{ts_id}/review",
            json={
                "name": "Maria Cargo",
                "matricula": "100002",
                "competencia": "07/2026",
                "employee_id": emp_id,
                "note": "",
            },
        )
        dispatch_id = ac.get("/api/dispatches").json()[0]["id"]
        resp = ac.post(
            f"/api/dispatches/{dispatch_id}/simulate-send",
            json={"result": "error"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "erro"

    def test_dispatch_resend(self, client):
        ac = _admin(client)
        preview = ac.post(
            "/api/employees/import/preview",
            files={"file": ("emp.csv", _employee_csv_content_acumula(), "text/csv")},
        ).json()
        ac.post("/api/employees/import/confirm", json={"preview_id": preview["preview_id"]})
        batch = _upload_empty_pdf(ac)
        ts_id = batch["timesheets"][0]["id"]
        emp_id = ac.get("/api/employees").json()[0]["id"]
        ac.post(
            f"/api/timesheets/{ts_id}/review",
            json={
                "name": "Maria Cargo",
                "matricula": "100002",
                "competencia": "07/2026",
                "employee_id": emp_id,
                "note": "",
            },
        )
        dispatch_id = ac.get("/api/dispatches").json()[0]["id"]
        # First send successfully
        ac.post(
            f"/api/dispatches/{dispatch_id}/simulate-send",
            json={"result": "success"},
        )
        # Resend
        resp = ac.post(f"/api/dispatches/{dispatch_id}/resend")
        assert resp.status_code == 200
        assert resp.json()["status"] == "pendente"
        assert resp.json()["authorized_by"] is None


# ===================================================================
# 7. Archive tests
# ===================================================================

class TestArchive:

    def test_archive_requires_employee_or_justification(self, client):
        ac = _admin(client)
        batch = _upload_empty_pdf(ac)
        ts_id = batch["timesheets"][0]["id"]
        resp = ac.post(
            f"/api/timesheets/{ts_id}/review",
            json={
                "name": "Teste",
                "matricula": "",
                "competencia": "07/2026",
                "employee_id": None,
                "note": "",
            },
        )
        assert resp.status_code == 422

    def test_archive_without_employee_with_note(self, client):
        ac = _admin(client)
        batch = _upload_empty_pdf(ac)
        ts_id = batch["timesheets"][0]["id"]
        resp = ac.post(
            f"/api/timesheets/{ts_id}/review",
            json={
                "name": "Sem servidor",
                "matricula": "",
                "competencia": "07/2026",
                "employee_id": None,
                "note": "Servidor não identificado, arquivo manualmente",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "arquivada"
        assert resp.json()["note"] != ""


# ===================================================================
# 8. Dashboard test
# ===================================================================

class TestDashboard:

    def test_dashboard_returns_real_data(self, client):
        ac = _admin(client)
        # Seed some data
        _upload_empty_pdf(ac)
        resp = ac.get("/api/dashboard?competency=07/2026")
        assert resp.status_code == 200
        body = resp.json()
        assert body["competency"] == "JULHO/2026"
        assert isinstance(body["total"], int)
        assert isinstance(body["recognition_rate"], (int, float))
        assert isinstance(body["dispatch_pending"], int)


# ===================================================================
# 9. Security tests
# ===================================================================

class TestSecurity:

    def test_token_revoked_after_logout(self, client):
        ac = _admin(client)
        # Confirm token works
        assert ac.get("/api/auth/me").status_code == 200
        # Logout
        ac.post("/api/auth/logout")
        # Same token must be rejected
        resp = ac.get("/api/auth/me")
        assert resp.status_code == 401
