"""
RPG Drive Sync — sincroniza imagens entre Google Drive e armazenamento local.

CONFIGURAÇÃO (primeira vez):
  1. Acesse https://console.cloud.google.com/
  2. Crie um projeto (ou use um existente)
  3. Pesquise "Google Drive API" → Ativar
  4. Vá em "Credenciais" → "Criar credenciais" → "ID do cliente OAuth 2.0"
  5. Tipo de aplicativo: "App para computador"
  6. Baixe o JSON → salve como: scripts/drive_credentials.json
  7. Execute este script uma vez → browser abre → faça login → token salvo
  8. Execuções subsequentes são silenciosas (token em scripts/drive_token.json)

  Instale as dependências (Python padrão, não precisa do venv SDXL):
    pip install google-api-python-client google-auth-oauthlib google-auth-httplib2

ESTRUTURA ESPERADA NO DRIVE:
  📁 RPG (sua pasta raiz — ID do URL)
    📁 cenarios/
      📁 chapel/    📁 village/   📁 dungeon/ ... (16 tipos do catalog.json)
    📁 retratos/
      📁 aliados/   📁 inimigos/  📁 neutros/
    📁 monstros/
      📁 undead/    📁 beast/     📁 humanoid/  📁 aberration/  📁 dragon/
    📁 curadoria/
      📁 cenarios/  📁 retratos/  📁 monstros/

  Se suas pastas tiverem nomes diferentes (ex: "paisagens" em vez de "cenarios"),
  edite o campo "folder_names" em storage/drive-config.json.

ESTRUTURA LOCAL ESPELHADA (após sync --download):
  storage/drive-cache/cenarios/chapel/*.png
  storage/drive-cache/retratos/aliados/*.png
  ...

IMAGENS GERADAS pelo servidor ficam em:
  storage/curadoria/cenarios/{tipo}/*.png
  storage/curadoria/retratos/*.png
  storage/curadoria/monstros/*.png

USO:
  python sync_drive.py                    # download + upload curadoria
  python sync_drive.py --download         # só baixar do Drive
  python sync_drive.py --upload           # só enviar curadoria ao Drive
  python sync_drive.py --list             # listar estrutura do Drive
  python sync_drive.py --reset-cache      # limpar cache de IDs (re-descobre pastas)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR    = Path(__file__).parent
STORAGE_DIR   = SCRIPT_DIR.parent / "apps" / "server" / "storage"
DRIVE_CONFIG  = STORAGE_DIR / "drive-config.json"
CREDENTIALS   = SCRIPT_DIR / "drive_credentials.json"
TOKEN_FILE    = SCRIPT_DIR / "drive_token.json"
DRIVE_CACHE   = STORAGE_DIR / "drive-cache"
CURATION_DIR  = STORAGE_DIR / "curadoria"

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
SCOPES = ["https://www.googleapis.com/auth/drive"]


# ── Auth ───────────────────────────────────────────────────────────────────────
def get_drive_service():
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print(
            "\n❌  Dependências não encontradas. Instale com:\n"
            "    pip install google-api-python-client google-auth-oauthlib google-auth-httplib2\n"
        )
        sys.exit(1)

    if not CREDENTIALS.exists():
        print(
            f"\n❌  Arquivo de credenciais não encontrado: {CREDENTIALS}\n"
            "    Siga as instruções no topo deste script para criar as credenciais OAuth.\n"
        )
        sys.exit(1)

    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception:
                creds = None

        if not creds:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS), SCOPES)
            creds = flow.run_local_server(port=0)

        TOKEN_FILE.write_text(creds.to_json())

    return build("drive", "v3", credentials=creds)


# ── Drive helpers ──────────────────────────────────────────────────────────────
def list_children(service, folder_id: str, mime_filter: str | None = None) -> list[dict]:
    """List all files/folders inside a Drive folder (handles pagination)."""
    items = []
    page_token = None
    q = f"'{folder_id}' in parents and trashed=false"
    if mime_filter:
        q += f" and mimeType='{mime_filter}'"

    while True:
        kwargs = dict(
            q=q,
            fields="nextPageToken, files(id, name, mimeType, size, modifiedTime)",
            pageSize=200,
        )
        if page_token:
            kwargs["pageToken"] = page_token
        resp = service.files().list(**kwargs).execute()
        items.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return items


def find_or_create_folder(service, name: str, parent_id: str) -> str:
    """Return Drive folder ID for `name` under `parent_id`, creating it if absent."""
    results = list_children(service, parent_id, mime_filter="application/vnd.google-apps.folder")
    for item in results:
        if item["name"].lower() == name.lower():
            return item["id"]

    # Create it
    meta = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    folder = service.files().create(body=meta, fields="id").execute()
    print(f"  📁  Created Drive folder: {name}")
    return folder["id"]


def download_file(service, file_id: str, dest: Path) -> None:
    """Download a Drive file to dest path."""
    from googleapiclient.http import MediaIoBaseDownload
    import io

    request = service.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(buf.getvalue())


def upload_file(service, local_path: Path, parent_id: str, remote_name: str | None = None) -> str:
    """Upload a local file to Drive under parent_id. Returns the new file ID."""
    from googleapiclient.http import MediaFileUpload

    name = remote_name or local_path.name
    mime = "image/png" if local_path.suffix.lower() == ".png" else "image/jpeg"
    meta = {"name": name, "parents": [parent_id]}
    media = MediaFileUpload(str(local_path), mimetype=mime, resumable=True)
    result = service.files().create(body=meta, media_body=media, fields="id").execute()
    return result["id"]


# ── Config helpers ─────────────────────────────────────────────────────────────
def load_config() -> dict:
    if not DRIVE_CONFIG.exists():
        print(f"❌  {DRIVE_CONFIG} not found. Did you set up the project?")
        sys.exit(1)
    with open(DRIVE_CONFIG, encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg: dict) -> None:
    with open(DRIVE_CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def get_folder_id(service, cfg: dict, *path_parts: str) -> str | None:
    """
    Resolve a Google Drive folder ID by navigating a path of folder names.
    Caches IDs in cfg["_folder_id_cache"] to avoid redundant API calls.

    path_parts examples:
      ("cenarios",)                   → the cenarios root folder
      ("cenarios", "chapel")          → chapel subfolder under cenarios
      ("curadoria", "cenarios")       → curadoria/cenarios
    """
    cache: dict = cfg.setdefault("_folder_id_cache", {})
    root_id: str = cfg["root_folder_id"]
    folder_names: dict = cfg.get("folder_names", {})

    cache_key = "/".join(path_parts)
    if cache_key in cache:
        return cache[cache_key]

    current_id = root_id
    for part in path_parts:
        # Allow remapping via config (e.g. "cenarios" → "paisagens" in Drive)
        drive_name = folder_names.get(part, part)
        children = list_children(service, current_id, "application/vnd.google-apps.folder")
        match = next((c for c in children if c["name"].lower() == drive_name.lower()), None)
        if not match:
            return None
        current_id = match["id"]

    cache[cache_key] = current_id
    return current_id


def ensure_folder_id(service, cfg: dict, *path_parts: str) -> str:
    """Like get_folder_id but creates missing folders."""
    cache: dict = cfg.setdefault("_folder_id_cache", {})
    root_id: str = cfg["root_folder_id"]
    folder_names: dict = cfg.get("folder_names", {})

    current_id = root_id
    accumulated: list[str] = []
    for part in path_parts:
        drive_name = folder_names.get(part, part)
        accumulated.append(part)
        cache_key = "/".join(accumulated)
        if cache_key in cache:
            current_id = cache[cache_key]
        else:
            current_id = find_or_create_folder(service, drive_name, current_id)
            cache[cache_key] = current_id

    return current_id


# ── Download (Drive → local) ───────────────────────────────────────────────────
def sync_download(service, cfg: dict) -> None:
    print("\n📥  Downloading from Google Drive → local cache...\n")

    # Build a flat list of (drive_path_parts, local_path_parts) to sync
    sync_pairs: list[tuple[tuple[str, ...], Path]] = []

    # cenarios/{scene_id}/ → drive-cache/cenarios/{scene_id}/
    # Also sync top-level cenarios images (flat Drive folder — no subfolders yet)
    sync_pairs.append((("cenarios",), DRIVE_CACHE / "cenarios"))

    scene_subfolder_names: dict = cfg.get("scene_subfolder_names", {})
    for scene_id, drive_name in scene_subfolder_names.items():
        sync_pairs.append(
            (("cenarios", scene_id), DRIVE_CACHE / "cenarios" / scene_id)
        )

    # retratos/{subfolder}/ groups
    retrato_subfolder_names: dict = cfg.get("retrato_subfolder_names", {})
    for sub_id, _drive_name in retrato_subfolder_names.items():
        sync_pairs.append(
            (("retratos", sub_id), DRIVE_CACHE / "retratos" / sub_id)
        )
    # Also sync top-level retratos images
    sync_pairs.append((("retratos",), DRIVE_CACHE / "retratos"))

    # monstros/{subfolder}/ groups
    monstro_subfolder_names: dict = cfg.get("monstro_subfolder_names", {})
    for sub_id, _drive_name in monstro_subfolder_names.items():
        sync_pairs.append(
            (("monstros", sub_id), DRIVE_CACHE / "monstros" / sub_id)
        )
    # Also sync top-level monstros images
    sync_pairs.append((("monstros",), DRIVE_CACHE / "monstros"))

    total_downloaded = 0
    total_skipped = 0

    for drive_path, local_dir in sync_pairs:
        folder_id = get_folder_id(service, cfg, *drive_path)
        if not folder_id:
            continue  # Folder doesn't exist yet in Drive — skip silently

        images = [f for f in list_children(service, folder_id)
                  if Path(f["name"]).suffix.lower() in SUPPORTED_EXTENSIONS]
        if not images:
            continue

        local_dir.mkdir(parents=True, exist_ok=True)
        folder_label = "/".join(drive_path)
        print(f"  📂  {folder_label}  ({len(images)} image(s))")

        for img in images:
            dest = local_dir / img["name"]
            if dest.exists():
                total_skipped += 1
                continue
            print(f"    ↓  {img['name']}")
            download_file(service, img["id"], dest)
            total_downloaded += 1
            time.sleep(0.1)  # gentle rate limiting

    save_config(cfg)
    print(f"\n✅  Download complete — {total_downloaded} new, {total_skipped} skipped.\n")


# ── Upload (local curadoria → Drive curadoria/) ────────────────────────────────
def sync_upload_curadoria(service, cfg: dict) -> None:
    print("\n📤  Uploading curadoria images → Google Drive...\n")

    if not CURATION_DIR.exists():
        print("  ℹ️   No curadoria folder found. Generate some images in-game first.\n")
        return

    total_uploaded = 0

    # Walk all files in curadoria/
    for local_path in sorted(CURATION_DIR.rglob("*")):
        if not local_path.is_file():
            continue
        if local_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue

        # Determine Drive destination path
        # local: curadoria/cenarios/chapel/abc.png
        # drive: curadoria/cenarios/chapel/abc.png
        relative = local_path.relative_to(CURATION_DIR)
        parts = list(relative.parts)  # e.g. ["cenarios", "chapel", "abc.png"]
        filename = parts[-1]
        folder_path_parts = ["curadoria"] + parts[:-1]

        drive_folder_id = ensure_folder_id(service, cfg, *folder_path_parts)

        # Check if already uploaded (by checking Drive for same filename)
        existing = list_children(service, drive_folder_id)
        if any(f["name"] == filename for f in existing):
            continue

        print(f"  ↑  {'/'.join(parts)}")
        upload_file(service, local_path, drive_folder_id)
        total_uploaded += 1
        time.sleep(0.1)

    save_config(cfg)
    print(f"\n✅  Upload complete — {total_uploaded} image(s) sent to Drive curadoria/.\n")
    if total_uploaded > 0:
        print(
            "  ℹ️   Next step: open Google Drive, review the curadoria/ folder,\n"
            "       move approved images to the correct cenarios/retratos/monstros subfolder,\n"
            "       then run  python sync_drive.py --download  to pull them into local cache.\n"
        )


# ── List ───────────────────────────────────────────────────────────────────────
def list_drive(service, cfg: dict) -> None:
    print(f"\n📋  Drive folder structure (root: {cfg['root_folder_id']})\n")

    def print_tree(folder_id: str, indent: int = 0) -> None:
        prefix = "  " * indent
        children = list_children(service, folder_id)
        folders = [c for c in children if c["mimeType"] == "application/vnd.google-apps.folder"]
        images  = [c for c in children if Path(c["name"]).suffix.lower() in SUPPORTED_EXTENSIONS]
        for f in sorted(folders, key=lambda x: x["name"]):
            count_imgs = len(list_children(service, f["id"]))
            print(f"{prefix}📁  {f['name']}  ({count_imgs} items)")
            print_tree(f["id"], indent + 1)
        if images:
            print(f"{prefix}🖼️   {len(images)} image(s): {', '.join(i['name'] for i in images[:5])}{'...' if len(images) > 5 else ''}")

    print_tree(cfg["root_folder_id"])
    print()


# ── CLI ────────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="RPG Drive Sync")
    parser.add_argument("--download",      action="store_true", help="Download Drive images → local cache")
    parser.add_argument("--upload",        action="store_true", help="Upload curadoria images → Drive")
    parser.add_argument("--list",          action="store_true", help="List Drive folder structure")
    parser.add_argument("--reset-cache",   action="store_true", help="Clear folder ID cache and re-discover")
    args = parser.parse_args()

    cfg = load_config()

    if args.reset_cache:
        cfg["_folder_id_cache"] = {}
        save_config(cfg)
        print("✅  Folder ID cache cleared.\n")

    service = get_drive_service()

    if args.list:
        list_drive(service, cfg)
        return

    # Default: both download and upload
    do_download = args.download or (not args.upload and not args.list)
    do_upload   = args.upload   or (not args.download and not args.list)

    if do_download:
        sync_download(service, cfg)
    if do_upload:
        sync_upload_curadoria(service, cfg)


if __name__ == "__main__":
    main()
