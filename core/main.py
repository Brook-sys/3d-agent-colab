"""
Núcleo do fluxo de peças paramétricas.

Um único processo FastAPI que serve três coisas:

  1. REST  (/parts, /mensagens, /anotacoes, /estado-plugin, /ponte/*)
     usado pelo painel (plugin Chili3D) e por qualquer cliente HTTP;
  2. MCP streamable-http em /mcp  — as ferramentas que o agente chama;
  3. arquivo de registro em /parts/<slug>/vN/ com git.

O núcleo nunca é a fonte da verdade da geometomia: a geometoria vive no
documento Chili3D (controlado pela ponte) ou num script build123d. O núcleo
arquiva, mede, valida e publica.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

# ----------------------------------------------------------------- config

PARTS_ROOT = Path(os.environ.get("PARTS_ROOT", "/parts"))
BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://session:17400").rstrip("/")
VENV_PYTHON = os.environ.get("VENV_PYTHON", "/venv/bin/python")
IMPRESSORA = {
    "modelo": os.environ.get("PRINTER_MODEL", "Elegoo Neptune 4"),
    "volume": [220.0, 220.0, 250.0],
    "bico": 0.4,
}
PROCESSO = {
    "parede_minima_mm": 1.6,
    "topo_minimo_mm": 0.8,
    "furo_minimo_mm": 1.6,
    "overhang_graus": 45.0,
    "ponte_maxima_mm": 10.0,
}
MATERIAIS = {"PLA": 1.24, "PETG": 1.27, "ABS": 1.04, "RESINA": 1.10}
FILAMENTO_DIAMETRO = 1.75

ESTADO_DIR = PARTS_ROOT / "_estado"
ESTADO_DIR.mkdir(parents=True, exist_ok=True)
for sub in ("mensagens", "plugin", "ponte"):
    (ESTADO_DIR / sub).mkdir(parents=True, exist_ok=True)


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return value or "peca"


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def git(args: list[str], cwd: Path = PARTS_ROOT) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=30
        )
        return proc.returncode, (proc.stdout + proc.stderr).strip()
    except Exception as err:  # git ausente ou timeout
        return 1, str(err)


# ------------------------------------------------------- ponte


def bridge_call(tool: str, args: dict[str, Any] | None = None, timeout: float = 240.0) -> dict[str, Any]:
    payload = json.dumps({"name": tool, "args": args or {}}).encode("utf-8")
    request = urllib.request.Request(
        f"{BRIDGE_URL}/call", data=payload, headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        return {"ok": False, "content": f"bridge HTTP {err.code}: {body[:400]}"}
    except Exception as err:
        return {"ok": False, "content": f"bridge indisponível: {err}"}


def bridge_tools() -> dict[str, Any]:
    try:
        with urllib.request.urlopen(f"{BRIDGE_URL}/tools", timeout=15) as res:
            return json.loads(res.read().decode("utf-8"))
    except Exception as err:
        return {"ok": False, "connected": False, "tools": [], "erro": str(err)}


def page_tool_names() -> list[str]:
    """Nomes reais das ferramentas que a página anunciou no `hello`."""
    tools = bridge_tools().get("tools") or []
    return [str(item.get("name")) for item in tools if isinstance(item, dict) and item.get("name")]


def pick_page_tool(*patterns: str) -> str | None:
    """
    Escolhe a ferramenta da página por padrão, não por nome fixo: os nomes do
    registro mudam entre versões do Chili3D e um nome errado aqui seria um
    `publicar` que falha sem explicação. `_` separa padrões, todos exigidos.
    """
    names = page_tool_names()
    if not names:
        return None
    scored: list[tuple[int, str]] = []
    for name in names:
        lowered = name.lower()
        if all(pattern.lower() in lowered for pattern in patterns):
            scored.append((-len(name), name))
    if not scored:
        return None
    scored.sort()
    return scored[0][1]


def looks_like_step(text: str) -> bool:
    head = text.lstrip()[:4096].upper()
    return "ISO-10303-21" in head or head.startswith("STEP") or "END-ISO-10303-21" in text[-2048:].upper()


def decode_step_payload(reply: dict[str, Any]) -> bytes | None:
    """A página pode devolver o STEP em base64, como texto puro ou como data URL."""
    import base64

    for key in ("bytes_b64", "b64", "content_b64"):
        value = reply.get(key)
        if isinstance(value, str) and value.strip():
            try:
                raw = base64.b64decode(value.strip() + "===")
                if looks_like_step(raw.decode("latin-1", "replace")):
                    return raw
            except Exception:
                continue
    content = reply.get("content")
    if isinstance(content, str) and looks_like_step(content):
        return content.encode("latin-1", "replace")
    for key in ("url", "download", "href"):
        value = reply.get(key)
        if isinstance(value, str) and value.startswith(("http://", "https://", "/")):
            try:
                with urllib.request.urlopen(value, timeout=60) as res:
                    raw = res.read()
                if looks_like_step(raw.decode("latin-1", "replace")):
                    return raw
            except Exception:
                continue
    return None


def parse_reply(reply: dict[str, Any]) -> Any:
    """
    O `content` de uma ferramenta da página é JSON dentro de uma string.

    Sem isso, quem chora "a página não devolveu STEP" olhando para o dicionário
    errado: o nome do arquivo exportado está é dentro do content.
    """
    content = reply.get("content")
    if isinstance(content, str):
        try:
            return json.loads(content)
        except Exception:
            return None
    return reply if isinstance(reply, dict) else None


def fetch_capture(filename: str) -> tuple[bytes | None, str | None]:
    """
    Busca os bytes de uma captura (o download que a página fez) pelo relay.

    `export_nodes` devolve só metadados (`{ok, filename, bytes}`) — a geometria
    vai para o disco do kiosk, e o servidor da ponte a publica em GET /capturas.
    """
    try:
        with urllib.request.urlopen(
            f"{BRIDGE_URL}/capturas/{urllib.parse.quote(filename)}", timeout=60
        ) as res:
            raw = res.read()
        if looks_like_step(raw.decode("latin-1", "replace")):
            return raw, None
        return None, f"a captura {filename} tem {len(raw)} bytes e não parece STEP"
    except urllib.error.HTTPError as err:
        return None, f"captura {filename} indisponível (HTTP {err.code})"
    except Exception as err:
        return None, f"captura {filename} indisponível ({err})"


def drop_capture(filename: str) -> None:
    """Remove a captura já arquivada — senão o volume da sessão só cresce."""
    try:
        req = urllib.request.Request(
            f"{BRIDGE_URL}/capturas/apagar",
            data=json.dumps({"nome": filename}).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as res:
            res.read()
    except Exception:
        pass  # a captura é lixo de 46 KB; perder o pedido não é falha de publicação


# ------------------------------------------------------- peça / versões


def part_dir(slug: str) -> Path:
    return PARTS_ROOT / slug


def version_dir(slug: str, number: int) -> Path:
    return part_dir(slug) / f"v{number:04d}"


def next_version(slug: str) -> int:
    directory = part_dir(slug)
    if not directory.exists():
        return 1
    versions = [
        int(match.group(1))
        for entry in directory.iterdir()
        if entry.is_dir() and (match := re.fullmatch(r"v(\d+)", entry.name))
    ]
    return max(versions, default=0) + 1


def part_index() -> list[dict[str, Any]]:
    out = []
    for directory in sorted(PARTS_ROOT.glob("*")):
        # `glob("*")` do pathlib também casa arquivos ocultos: sem esse filtro
        # o `.git` do registro aparecia como uma terceira peça.
        if not directory.is_dir() or directory.name.startswith((".", "_")):
            continue
        versions = sorted(
            int(match.group(1))
            for entry in directory.iterdir()
            if entry.is_dir() and (match := re.fullmatch(r"v(\d+)", entry.name))
        )
        info = read_json(directory / "spec.json", {})
        out.append(
            {
                "slug": directory.name,
                "intencao": info.get("intencao", ""),
                "versoes": versions,
                "ultima_versao": versions[-1] if versions else None,
            }
        )
    return out


def git_commit(slug: str, version: int, message: str) -> None:
    if not (PARTS_ROOT / ".git").exists():
        git(["init", "--quiet"])
        git(["config", "user.email", "fluxo@local"])
        git(["config", "user.name", "Fluxo de Peças"])
    git(["add", "-A"])
    git(["commit", "--quiet", "-m", f"{slug} v{version:04d}: {message}"])


# ------------------------------------------------------------- validação


def load_shape(step_path: Path):
    """Importa o STEP com build123d/OCP; devolve (shape, availável?)."""
    try:
        from build123d import import_step  # type: ignore
    except Exception as err:
        return None, f"build123d indisponível: {err}"
    try:
        return import_step(str(step_path)), None
    except Exception as err:
        return None, f"falha ao importar STEP: {err}"


def shape_metrics(shape) -> dict[str, Any]:
    from build123d import Axis  # type: ignore

    volume = float(shape.volume)
    area = float(shape.area)
    bbox = shape.bounding_box()
    center = shape.center()
    return {
        "volume_mm3": round(volume, 3),
        "area_mm2": round(area, 3),
        "bbox_mm": {
            "min": [round(v, 3) for v in (bbox.min.X, bbox.min.Y, bbox.min.Z)],
            "max": [round(v, 3) for v in (bbox.max.X, bbox.max.Y, bbox.max.Z)],
            "size": [round(v, 3) for v in (bbox.size.X, bbox.size.Y, bbox.size.Z)],
        },
        "centro_mm": [round(center.X, 3), round(center.Y, 3), round(center.Z, 3)],
        "solidos": len(shape.solids()),
        "faces": len(shape.faces()),
        "arestas": len(shape.edges()),
    }


def validate_version(slug: str, number: int, material: str = "PLA") -> dict[str, Any]:
    directory = version_dir(slug, number)
    step = directory / "model.step"
    result: dict[str, Any] = {
        "slug": slug,
        "versao": number,
        "gerado_em": utcnow(),
        "processo": "FDM 0.4mm",
        "impressora": IMPRESSORA,
        "regras": PROCESSO,
    }
    if not step.exists():
        result["veredicto"] = "bloqueado"
        result["problemas"] = ["nenhum model.step nesta versão"]
        write_json(directory / "validacao.json", result)
        return result

    previous = number - 1
    delta = None
    if previous >= 1:
        old = read_json(version_dir(slug, previous) / "validacao.json", {})
        if old.get("metricas", {}).get("volume_mm3"):
            delta = old["metricas"]["volume_mm3"]

    shape, error = load_shape(step)
    if error:
        result["veredicto"] = "bloqueado"
        result["problemas"] = [error]
        write_json(directory / "validacao.json", result)
        return result

    metrics = shape_metrics(shape)
    size = metrics["bbox_mm"]["size"]
    printer = IMPRESSORA["volume"]
    material = material.upper()
    density = MATERIAIS.get(material, MATERIAIS["PLA"])
    mass_g = metrics["volume_mm3"] / 1000.0 * density
    filament_m = metrics["volume_mm3"] / (3.14159265 * (FILAMENTO_DIAMETRO / 2) ** 2) / 1000.0

    problemas: list[str] = []
    avisos: list[str] = []
    if any(size[i] > printer[i] for i in range(3)):
        problemas.append(f"envelope {size} excede o volume da impressora {printer}")
    if metrics["solidos"] != 1:
        avisos.append(f"{metrics['solidos']} sólidos: confirme se é um conjunto ou uma peça com corpo solto")
    if delta and abs(metrics["volume_mm3"] - delta) / max(delta, 1e-9) > 0.5:
        avisos.append(
            f"volume mudou {round((metrics['volume_mm3'] - delta) / max(delta, 1e-9) * 100, 1)}% vs. v{previous:04d}"
        )

    result.update(
        {
            "metricas": metrics,
            "material": material,
            "densidade_g_cm3": density,
            "massa_g": round(mass_g, 2),
            "filamento_m": round(filament_m, 2),
            "delta_volume_vs_anterior": None if delta is None else round(metrics["volume_mm3"] - delta, 3),
            "problemas": problemas,
            "avisos": avisos,
            "veredicto": "bloqueado" if problemas else ("atencao" if avisos else "ok"),
        }
    )
    result["limitacoes"] = [
        "espessura de parede, overhang e diâmetro mínimo de furo NÃO são medidos na geometria:",
        "só o envelope, volume, topologia e massa são calculados do BREP.",
        "As regras declaradas no spec são conferidas pelo agente na revisão.",
    ]
    write_json(directory / "validacao.json", result)
    return result


# ------------------------------------------------- construção build123d


def run_python_build(slug: str, code: str, material: str = "PLA") -> dict[str, Any]:
    """Caminho headless (Opção A): compila um script build123d e arquiva a versão."""
    number = next_version(slug)
    directory = version_dir(slug, number)
    directory.mkdir(parents=True, exist_ok=True)
    script = directory / "model.py"
    script.write_text(code, encoding="utf-8")
    step_path = directory / "model.step"
    stl_path = directory / "model.stl"
    export = directory / "modelo-export.py"
    export.write_text(
        f'''"""Gerado pelo núcleo — executa o script da peça e exporta STEP + STL."""
import json
import runpy

from build123d import export_step, export_stl

ns = runpy.run_path(r"{script}")
shape = ns.get("result")
if shape is None:
    raise SystemExit("o script não definiu 'result'")
export_step(shape, r"{step_path}")
export_stl(shape, r"{stl_path}", tolerance=0.05, angularTolerance=0.3)
print(json.dumps({{
    "volume_mm3": shape.volume, "area_mm2": shape.area,
    "solidos": len(shape.solids()), "faces": len(shape.faces()),
}}))
''',
        encoding="utf-8",
    )
    proc = subprocess.run(
        [VENV_PYTHON, str(export)],
        capture_output=True,
        text=True,
        timeout=600,
        cwd=str(directory),
    )
    if proc.returncode != 0 or not (directory / "model.step").exists():
        return {
            "ok": False,
            "versao": number,
            "erro": (proc.stderr or proc.stdout)[-3000:],
        }
    params = extract_params(code)
    write_json(directory / "params.json", {"fonte": "python", "params": params, "material": material})
    write_json(directory / "manifest.json", {"criado_em": utcnow(), "fonte": "python"})
    git_commit(slug, number, "build python headless")
    validation = validate_version(slug, number, material)
    return {"ok": True, "versao": number, "validacao": validation, "stdout": proc.stdout[-2000:]}


def extract_params(code: str) -> dict[str, Any]:
    """Parâmetros nomeados no topo do script (linhas `nome = número # comentário`)."""
    params: dict[str, Any] = {}
    for line in code.splitlines()[:60]:
        match = re.match(r"^([a-zA-Z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)\s*(?:#\s*(.*))?$", line.strip())
        if match and match.group(1) not in {"result", "part"}:
            params[match.group(1)] = {
                "valor": float(match.group(2)),
                "fonte": "assumido",
                "nota": match.group(3) or "",
            }
    return params


# ------------------------------------------------------------------ app

app = FastAPI(title="Núcleo do Fluxo de Peças", version="1.0.0")

# O painel é servido pelo nginx (outra origem) e bate aqui no navegador do usuário.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    bridge = bridge_tools()
    return {
        "ok": True,
        "utc": utcnow(),
        "ponte": {"conectada": bridge.get("connected", False), "ferramentas": len(bridge.get("tools", []))},
        "partes": len(part_index()),
    }


@app.get("/ponte/estado")
async def ponte_estado() -> dict[str, Any]:
    bridge = bridge_tools()
    return {
        "conectada": bridge.get("connected", False),
        "ferramentas": len(bridge.get("tools", [])),
        "url": BRIDGE_URL,
    }


@app.post("/ponte/chamar")
async def ponte_chamar(request: Request) -> dict[str, Any]:
    body = await request.json()
    return bridge_call(str(body.get("name", "")), body.get("args") or {})


@app.post("/estado-plugin")
async def estado_plugin(request: Request) -> dict[str, Any]:
    body = await request.json()
    slug = slugify(str(body.get("parte", "teste")))
    write_json(ESTADO_DIR / "plugin" / f"{slug}.json", {"recebido_em": utcnow(), **body})
    return {"ok": True}


@app.get("/mensagens")
async def mensagens_listar() -> dict[str, Any]:
    path = ESTADO_DIR / "mensagens" / "conversa.json"
    return {"mensagens": read_json(path, [])}


@app.post("/mensagens")
async def mensagens_enviar(request: Request) -> dict[str, Any]:
    body = await request.json()
    path = ESTADO_DIR / "mensagens" / "conversa.json"
    items = read_json(path, [])
    items.append(
        {
            "autor": str(body.get("autor", "usuario")),
            "texto": str(body.get("texto", "")),
            "parte": body.get("parte"),
            "em": utcnow(),
        }
    )
    write_json(path, items[-500:])
    return {"ok": True, "total": len(items)}


@app.post("/parts")
async def parts_criar(request: Request) -> dict[str, Any]:
    body = await request.json()
    slug = slugify(str(body.get("slug") or body.get("nome") or ""))
    directory = part_dir(slug)
    directory.mkdir(parents=True, exist_ok=True)
    spec = {
        "slug": slug,
        "intencao": str(body.get("intencao", "")),
        "material": str(body.get("material", "PLA")),
        "processo": "FDM 0.4mm",
        "criado_em": utcnow(),
        "params": {},
    }
    if not (directory / "spec.json").exists():
        write_json(directory / "spec.json", spec)
        (directory / "spec.md").write_text(
            f"# {slug}\n\n## Intenção\n\n{spec['intencao']}\n\n## Parâmetros\n\n| nome | valor | fonte | nota |\n|---|---|---|---|\n\n",
            encoding="utf-8",
        )
    git_commit(slug, 0, "peça criada")
    return {"ok": True, "slug": slug, "spec": spec}


@app.get("/parts")
async def parts_listar() -> dict[str, Any]:
    return {"parts": part_index()}


@app.get("/parts/{slug}")
async def parts_detalhe(slug: str) -> dict[str, Any]:
    directory = part_dir(slug)
    if not directory.exists():
        return {"erro": f"peça inexistente: {slug}"}
    spec = read_json(directory / "spec.json", {})
    versions = part_index()
    entry = next((item for item in versions if item["slug"] == slug), None)
    last = entry["versoes"] if entry else []
    validacao = None
    if last:
        validacao = read_json(version_dir(slug, last[-1]) / "validacao.json", None)
    return {
        "slug": slug,
        "intencao": spec.get("intencao", ""),
        "material": spec.get("material", "PLA"),
        "versoes": last,
        "ultima_versao": entry["ultima_versao"] if entry else None,
        "ultima_validacao": validacao,
    }


def publish_version(slug: str, body: dict[str, Any]) -> dict[str, Any]:
    """
    Publica uma versão: captura estado/STEP da página pela ponte e arquiva.

    Os nomes das ferramentas da página são descobertos por padrão (ver
    `pick_page_tool`) — nada aqui depende de um nome fixo do registro.
    """
    directory = part_dir(slug)
    if not directory.exists():
        return {"ok": False, "erro": f"peça inexistente: {slug}"}

    # >>> A ordem aqui é a correção de um defeito real: a versão era criada
    # ANTES de saber se havia documento, então um kiosk recarregado (o
    # documento vive na RAM da página) produzia um diretório vN/ sem STEP,
    # 30 segundos de espera por um download que nunca viria e um veredicto
    # "bloqueado" arquivado no registro. Confira primeiro, arquive depois.
    state_tool = pick_page_tool("document", "state") or pick_page_tool("document")
    state = (
        bridge_call(state_tool, {})
        if state_tool
        else {"ok": False, "content": "sem ferramenta de estado do documento"}
    )
    conteudo_estado = parse_reply(state) or {}
    sem_documento = bool(
        not state.get("ok")  # a ponte não respondeu: não há como exportar nada
        or conteudo_estado.get("error")
        or (isinstance(state.get("content"), str) and "no open document" in state["content"].lower())
        or conteudo_estado.get("hasActiveDocument") is False
    )
    if sem_documento:
        return {
            "ok": False,
            "erro": (
                "a página não tem documento aberto — o kiosk foi recarregado "
                "ou a peça não foi modelada ainda. Reconstrua o documento "
                "(run_parametric) antes de publicar."
            ),
            "diagnostico": {"estado": state.get("content")},
        }

    number = next_version(slug)
    target = version_dir(slug, number)
    target.mkdir(parents=True, exist_ok=True)
    material = str(body.get("material") or read_json(directory / "spec.json", {}).get("material", "PLA"))

    diagnostico: dict[str, Any] = {"versao": number, "material": material}
    diagnostico["ferramenta_estado"] = state_tool
    write_json(target / "documento.json", {"ferramenta": state_tool, "conteudo": state.get("content")})

    export_tool = pick_page_tool("export", "node") or pick_page_tool("export")
    exported: dict[str, Any] = {"ok": False, "content": "sem ferramenta de exportação"}
    step_bytes: bytes | None = None
    if export_tool:
        # Nome com marca única: a captura é identificada pelo nome exato, então
        # uma publicação não pode pegar o arquivo da anterior.
        marca = uuid.uuid4().hex[:8]
        arquivo = f"{slug}-v{number:04d}-{marca}.step"
        # `export_nodes` exige `format` ("required": ["format"]) e nomeia o
        # arquivo em `filename`; `name` puro nem existe no schema.
        exported = bridge_call(export_tool, {"format": ".step", "filename": arquivo})
        diagnostico["export_pedido"] = {"ferramenta": export_tool, "arquivo": arquivo}
        conteudo = parse_reply(exported) or {}
        nome_captura = str(conteudo.get("filename") or arquivo)
        if not exported.get("ok") or conteudo.get("error"):
            diagnostico["step"] = f"export falhou: {exported.get('content')}"
        else:
            # O download é assíncrono: a gravação em disco acontece depois da
            # resposta da ferramenta. Espera curta e explícita, sem dormir à toa.
            prazo = time.time() + 30
            while time.time() < prazo:
                step_bytes, erro = fetch_capture(nome_captura)
                if step_bytes:
                    break
                time.sleep(1.0)
            if step_bytes:
                (target / "model.step").write_bytes(step_bytes)
                diagnostico["step_bytes"] = len(step_bytes)
                diagnostico["step"] = f"{nome_captura} ({len(step_bytes)} bytes)"
                drop_capture(nome_captura)
            else:
                diagnostico["step"] = erro or "a página não devolveu STEP reconhecível"
    else:
        write_json(target / "export-step.json", exported)

    if step_bytes is None:
        # Caminho alternativo: alguma ferramenta/versoção que devolva os bytes
        # no próprio conteúdo da resposta. Hoje a página não faz isso.
        inline = decode_step_payload(exported)
        if inline:
            (target / "model.step").write_bytes(inline)
            step_bytes = inline
            diagnostico["step_bytes"] = len(inline)
        elif "step" not in diagnostico:
            write_json(target / "export-step.json", exported)
            diagnostico["step"] = exported.get("content") or "a página não devolveu STEP"

    write_json(
        target / "params.json",
        {
            "fonte": "pagina",
            "params": body.get("params", {}),
            "variaveis": body.get("variaveis", []),
            "material": material,
            "publicado_em": utcnow(),
            "diagnostico": diagnostico,
        },
    )
    # Uma versão sem STEP continua arquivada (o registro da tentativa é útil
    # para depurar), mas fica marcada: senão ela parece uma peça pronta e o
    # próximo `validar` repete o "bloqueado" sem explicar o motivo.
    completa = step_bytes is not None and (target / "model.step").exists()
    write_json(
        target / "manifest.json",
        {
            "criado_em": utcnow(),
            "fonte": "pagina",
            "completa": completa,
            "sem_step": not completa,
        },
    )
    git_commit(slug, number, "publicado" if completa else "publicação incompleta (sem STEP)")
    validation = validate_version(slug, number, material)
    return {
        "ok": True,
        "slug": slug,
        "versao": number,
        "validacao": validation,
        "diagnostico": diagnostico,
    }


@app.post("/parts/{slug}/publicar")
async def parts_publicar(slug: str, request: Request) -> dict[str, Any]:
    """Publica uma versão: pede o documento/STEP à página pela ponte e arquiva."""
    body = await request.json()
    return publish_version(slugify(slug), body)


@app.get("/parts/{slug}/versoes")
async def parts_versoes(slug: str) -> dict[str, Any]:
    directory = part_dir(slug)
    versions = sorted(
        int(match.group(1))
        for entry in directory.iterdir()
        if entry.is_dir() and (match := re.fullmatch(r"v(\d+)", entry.name))
    ) if directory.exists() else []
    return {"slug": slug, "versoes": versions}


@app.post("/parts/{slug}/versoes/{numero}/validar")
async def parts_validar(slug: str, numero: int) -> dict[str, Any]:
    spec = read_json(part_dir(slug) / "spec.json", {})
    return validate_version(slug, numero, spec.get("material", "PLA"))


@app.get("/parts/{slug}/anotacoes")
async def anotacoes_listar(slug: str) -> dict[str, Any]:
    path = part_dir(slug) / "anotacoes.json"
    return {"anotacoes": read_json(path, [])}


@app.post("/parts/{slug}/anotacoes")
async def anotacoes_criar(slug: str, request: Request) -> dict[str, Any]:
    body = await request.json()
    path = part_dir(slug) / "anotacoes.json"
    items = read_json(path, [])
    items.append(
        {
            "autor": str(body.get("autor", "usuario")),
            "texto": str(body.get("texto", "")),
            "selecao": body.get("selecao"),
            "variaveis": body.get("variaveis"),
            "em": utcnow(),
            "estado": "aberto",
        }
    )
    write_json(path, items)
    return {"ok": True, "total": len(items)}


@app.get("/arquivos/{caminho:path}")
async def arquivos(caminho: str) -> Response:
    base = PARTS_ROOT.resolve()
    target = (base / caminho).resolve()
    if not str(target).startswith(str(base)) or not target.is_file():
        return JSONResponse({"erro": "arquivo inexistente"}, status_code=404)
    return Response(target.read_bytes(), media_type="application/octet-stream")


# ------------------------------------------------------------------ MCP


TOOLS: dict[str, dict[str, Any]] = {}


def tool(name: str, description: str, schema: dict[str, Any]):
    def decorator(func):
        TOOLS[name] = {"handler": func, "description": description, "schema": schema}
        return func

    return decorator


@tool("partes", "Lista as peças do arquivo de registro com suas versões.", {"type": "object", "properties": {}})
def mcp_partes() -> dict[str, Any]:
    return {"parts": part_index()}


@tool(
    "parte_criar",
    "Cria uma peça nova com slug, intenção e material.",
    {
        "type": "object",
        "properties": {
            "slug": {"type": "string"},
            "intencao": {"type": "string"},
            "material": {"type": "string", "enum": ["PLA", "PETG", "ABS", "RESINA"]},
        },
        "required": ["slug"],
    },
)
def mcp_parte_criar(slug: str, intencao: str = "", material: str = "PLA") -> dict[str, Any]:
    slug = slugify(slug)
    directory = part_dir(slug)
    directory.mkdir(parents=True, exist_ok=True)
    if not (directory / "spec.json").exists():
        write_json(
            directory / "spec.json",
            {
                "slug": slug,
                "intencao": intencao,
                "material": material,
                "processo": "FDM 0.4mm",
                "criado_em": utcnow(),
            },
        )
    (directory / "spec.md").write_text(
        f"# {slug}\n\n## Intenção\n\n{intencao}\n\n## Parâmetros\n\n"
        "| nome | valor | fonte | nota |\n|---|---|---|---|\n\n",
        encoding="utf-8",
    )
    git_commit(slug, 0, "peça criada pelo agente")
    return {"ok": True, "slug": slug}


@tool("ponte_estado", "Estado da ponte com o Chili3D (página conectada? quantas ferramentas?).", {"type": "object", "properties": {}})
def mcp_ponte_estado() -> dict[str, Any]:
    bridge = bridge_tools()
    return {"conectada": bridge.get("connected", False), "ferramentas": len(bridge.get("tools", []))}


@tool(
    "ponte_ferramentas",
    "Lista as ferramentas que a página Chili3D expõe (nome, descrição, schema).",
    {"type": "object", "properties": {}},
)
def mcp_ponte_ferramentas() -> dict[str, Any]:
    bridge = bridge_tools()
    return {"conectada": bridge.get("connected", False), "ferramentas": bridge.get("tools", [])}


@tool(
    "pagina_chamar",
    "Chama uma ferramenta qualquer da página Chili3D pela ponte. Use ponte_ferramentas para descobrir os nomes.",
    {
        "type": "object",
        "properties": {"nome": {"type": "string"}, "args": {"type": "object"}},
        "required": ["nome"],
    },
)
def mcp_pagina_chamar(nome: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
    return bridge_call(nome, args or {})


@tool(
    "variaveis",
    "Lê ou escreve as variáveis do documento Chili3D (document_variables).",
    {
        "type": "object",
        "properties": {
            "acao": {"type": "string", "enum": ["list", "set", "remove"], "default": "list"},
            "variaveis": {"type": "array", "items": {"type": "object"}},
            "nomes": {"type": "array", "items": {"type": "string"}},
        },
    },
)
def mcp_variaveis(acao: str = "list", variaveis: list[dict[str, Any]] | None = None, nomes: list[str] | None = None) -> dict[str, Any]:
    args: dict[str, Any] = {"action": acao}
    if variaveis:
        args["variables"] = variaveis
    if nomes:
        args["names"] = nomes
    return bridge_call("document_variables", args)


@tool(
    "publicar",
    "Publica uma versão da peça: exporta o documento/STEP pela ponte, arquiva e valida.",
    {
        "type": "object",
        "properties": {"slug": {"type": "string"}, "material": {"type": "string"}},
        "required": ["slug"],
    },
)
def mcp_publicar(slug: str, material: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if material:
        body["material"] = material
    variaveis = bridge_call("document_variables", {"action": "list"})
    body["variaveis"] = variaveis.get("content") if variaveis.get("ok") else variaveis.get("content")
    return publish_version(slugify(slug), body)


@tool(
    "validar",
    "Roda o portal de validação FDM numa versão (ou na última) de uma peça.",
    {
        "type": "object",
        "properties": {"slug": {"type": "string"}, "versao": {"type": "integer"}},
        "required": ["slug"],
    },
)
def mcp_validar(slug: str, versao: int | None = None) -> dict[str, Any]:
    slug = slugify(slug)
    directory = part_dir(slug)
    if not directory.exists():
        return {"ok": False, "erro": "peça inexistente"}
    if versao is None:
        versions = sorted(
            int(match.group(1))
            for entry in directory.iterdir()
            if entry.is_dir() and (match := re.fullmatch(r"v(\d+)", entry.name))
        )
        if not versions:
            return {"ok": False, "erro": "peça sem versões"}
        versao = versions[-1]
    spec = read_json(directory / "spec.json", {})
    return validate_version(slug, versao, spec.get("material", "PLA"))


@tool(
    "construir_python",
    "Caminho headless: compila um script build123d (deve definir 'result') e arquiva a versão com STEP/STL.",
    {
        "type": "object",
        "properties": {
            "slug": {"type": "string"},
            "codigo": {"type": "string"},
            "material": {"type": "string"},
        },
        "required": ["slug", "codigo"],
    },
)
def mcp_construir_python(slug: str, codigo: str, material: str = "PLA") -> dict[str, Any]:
    slug = slugify(slug)
    part_dir(slug).mkdir(parents=True, exist_ok=True)
    return run_python_build(slug, codigo, material)


@tool("mensagens", "Lê as mensagens da fila compartilhada (web + terminal).", {"type": "object", "properties": {}})
def mcp_mensagens() -> dict[str, Any]:
    return {"mensagens": read_json(ESTADO_DIR / "mensagens" / "conversa.json", [])}


@tool(
    "enviar_mensagem",
    "Escreve uma mensagem na fila compartilhada (aparece no painel web).",
    {
        "type": "object",
        "properties": {"texto": {"type": "string"}, "parte": {"type": "string"}},
        "required": ["texto"],
    },
)
def mcp_enviar_mensagem(texto: str, parte: str | None = None) -> dict[str, Any]:
    path = ESTADO_DIR / "mensagens" / "conversa.json"
    items = read_json(path, [])
    items.append({"autor": "agente", "texto": texto, "parte": parte, "em": utcnow()})
    write_json(path, items[-500:])
    return {"ok": True, "total": len(items)}


@tool("anotacoes", "Lista os comentários ancorados de uma peça.", {"type": "object", "properties": {"slug": {"type": "string"}}})
def mcp_anotacoes(slug: str) -> dict[str, Any]:
    return {"anotacoes": read_json(part_dir(slugify(slug)) / "anotacoes.json", [])}


@tool(
    "estado_plugin",
    "Último estado reportado pelo painel (plugin) de cada peça.",
    {"type": "object", "properties": {}},
)
def mcp_estado_plugin() -> dict[str, Any]:
    out = {}
    for path in (ESTADO_DIR / "plugin").glob("*.json"):
        out[path.stem] = read_json(path, {})
    return {"plugins": out}


def mcp_tools_list() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "description": info["description"],
            "inputSchema": info["schema"],
        }
        for name, info in TOOLS.items()
    ]


@app.post("/mcp")
async def mcp_endpoint(request: Request) -> Response:
    """
    MCP streamable-http mínimo (JSON-RPC 2.0), stateless.
    Métodos: initialize, notifications/initialized, tools/list, tools/call, ping.
    """
    body = await request.json()
    method = body.get("method")
    request_id = body.get("id")
    session_id = request.headers.get("mcp-session-id") or str(uuid.uuid4())

    def reply(payload: dict[str, Any], status: int = 200) -> Response:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": request_id, **payload},
            status_code=status,
            headers={"Mcp-Session-Id": session_id},
        )

    if method in (None, "notifications/initialized", "initialized"):
        return Response(status_code=202, headers={"Mcp-Session-Id": session_id})

    if method == "initialize":
        return reply(
            {
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fluxo-pecas", "version": "1.0.0"},
                }
            }
        )

    if method == "ping":
        return reply({"result": {}})

    if method == "tools/list":
        return reply({"result": {"tools": mcp_tools_list()}})

    if method == "tools/call":
        params = body.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        info = TOOLS.get(name)
        if not info:
            return reply({"error": {"code": -32602, "message": f"ferramenta desconhecida: {name}"}})
        try:
            result = info["handler"](**arguments)
            if asyncio.iscoroutine(result):
                result = await result
            return reply(
                {
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
                        "structuredContent": result,
                    }
                }
            )
        except TypeError as err:
            return reply({"error": {"code": -32602, "message": f"argumentos inválidos: {err}"}})
        except Exception as err:  # não derruba o servidor por falha de ferramenta
            return reply(
                {
                    "result": {
                        "content": [{"type": "text", "text": f"erro: {err}"}],
                        "isError": True,
                    }
                }
            )

    if request_id is None:
        return Response(status_code=202, headers={"Mcp-Session-Id": session_id})
    return reply({"error": {"code": -32601, "message": f"método desconhecido: {method}"}})


@app.get("/mcp")
async def mcp_get() -> dict[str, Any]:
    return {"erro": "use POST para chamadas MCP (streamable-http)"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9001")), log_level="info")
