import csv
import io
from pathlib import Path

import fitz
import openpyxl
import pytest
from fastapi.testclient import TestClient

import server
from FolhaPontoBack import processing


ADMIN_USERNAME = "admin@undf.edu.br"
ADMIN_PASSWORD = "admin123"


@pytest.fixture
def client(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    upload_dir = data_dir / "uploads"
    upload_dir.mkdir(parents=True)
    monkeypatch.setattr(server, "DATA_DIR", data_dir)
    monkeypatch.setattr(server, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(server, "DB_PATH", data_dir / "digep.sqlite3")
    monkeypatch.setenv("ADMIN_USERNAME", ADMIN_USERNAME)
    monkeypatch.setenv("ADMIN_PASSWORD", ADMIN_PASSWORD)
    with TestClient(server.app) as test_client:
        token = test_client.post(
            "/api/auth/login",
            json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
        ).json()["access_token"]
        yield AuthedClient(test_client, token)


class AuthedClient:
    def __init__(self, client, token):
        self._client = client
        self._headers = {"Authorization": f"Bearer {token}"}

    def request(self, method, url, **kwargs):
        headers = dict(self._headers)
        headers.update(kwargs.pop("headers", {}))
        return self._client.request(method, url, headers=headers, **kwargs)

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def __getattr__(self, name):
        return getattr(self._client, name)


def three_page_pdf() -> bytes:
    document = fitz.open()
    for _ in range(3):
        document.new_page(width=300, height=400)
    return document.tobytes()


def valid_xlsx(rows: list[list[str]]) -> bytes:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["Nome", "Matrícula", "CPF", "E-mail", "Carga Horária", "Acumula cargo (Sim/Não)"])
    for row in rows:
        sheet.append(row)
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_pdf_with_three_pages_creates_individual_records_and_files(client, monkeypatch):
    monkeypatch.setattr(processing, "_run_ocr", lambda _: ("", "ocr-indisponivel"))
    content = three_page_pdf()
    response = client.post(
        "/api/batches",
        files={"file": ("folhas.pdf", content, "application/pdf")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["pages"] == 3
    assert len(body["timesheets"]) == 3
    assert all(page["mode"] == "ocr-indisponivel" for page in body["timesheets"])

    rows = client.get("/api/timesheets?competency=07/2026").json()
    assert len(rows) == 0
    all_rows = client.get("/api/timesheets?competency=NÃO%20RECONHECIDA").json()
    assert len(all_rows) == 3
    assert all(row["name"] == "Não identificado" for row in all_rows)
    assert all(row["download_url"] for row in all_rows)
    download = client.get(all_rows[0]["download_url"])
    assert download.status_code == 200
    assert download.content.startswith(b"%PDF")

    duplicate = client.post(
        "/api/batches",
        files={"file": ("folhas.pdf", content, "application/pdf")},
    )
    assert duplicate.status_code == 409


def test_review_and_archive_real_page(client, monkeypatch):
    monkeypatch.setattr(processing, "_run_ocr", lambda _: ("", "ocr-indisponivel"))
    created = client.post("/api/batches", files={"file": ("one.pdf", three_page_pdf(), "application/pdf")}).json()
    timesheet_id = created["timesheets"][0]["id"]
    response = client.post(
        f"/api/timesheets/{timesheet_id}/review",
        json={"name": "Servidor Conferido", "matricula": "12345678", "competencia": "JULHO/2026", "note": "Conferido"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "arquivada"
    assert client.get(f"/api/timesheets/{timesheet_id}/download").status_code == 200


def test_xlsx_preview_confirm_update_and_duplicate_validation(client):
    content = valid_xlsx([
        ["Ana Teste", "12345678", "11122233344", "ana@example.com", "40", "Não"],
        ["Ana Duplicada", "12345678", "11122233344", "ana2@example.com", "40", "Não"],
    ])
    preview = client.post("/api/employees/import/preview", files={"file": ("servidores.xlsx", content)}).json()
    assert preview["valid_rows"] == 1
    assert preview["invalid_rows"] == 1
    assert "Matrícula duplicada" in preview["errors"][0]["errors"][0]
    confirmed = client.post("/api/employees/import/confirm", json={"preview_id": preview["preview_id"]})
    assert confirmed.status_code == 200
    assert confirmed.json()["inserted"] == 1

    updated_content = valid_xlsx([["Ana Atualizada", "12345678", "11122233344", "nova@example.com", "30", "Sim"]])
    update_preview = client.post("/api/employees/import/preview", files={"file": ("servidores.xlsx", updated_content)}).json()
    assert update_preview["rows"][0]["action"] == "update"
    updated = client.post("/api/employees/import/confirm", json={"preview_id": update_preview["preview_id"]}).json()
    assert updated["updated"] == 1
    employee = client.get("/api/employees").json()[0]
    assert employee["name"] == "Ana Atualizada"
    assert employee["carga_horaria"] == 30


def test_csv_invalid_columns_is_rejected(client):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Nome", "Matrícula"])
    writer.writerow(["Sem dados", "123"])
    response = client.post(
        "/api/employees/import/preview",
        files={"file": ("servidores.csv", output.getvalue().encode(), "text/csv")},
    )
    assert response.status_code == 422


def test_processing_extracts_each_page_from_text_pdf(tmp_path):
    document = fitz.open()
    page = document.new_page()
    page.insert_text((30, 50), "REFERÊNCIA: JULHO/2026\nMATRÍCULA: 17289106\nNOME DO SERVIDOR: ALEXANDRE NATA VICENTE")
    source = tmp_path / "texto.pdf"
    document.save(source)
    document.close()

    result = processing.process_document(source, tmp_path / "pages")
    assert result["pages"] == 1
    assert result["page_results"][0]["extraction"]["matricula"] == "17289106"
    assert Path(result["page_results"][0]["stored_path"]).is_file()