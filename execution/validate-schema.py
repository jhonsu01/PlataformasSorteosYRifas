#!/usr/bin/env python3
"""
Validador de JSON publicos de rifas (Capa 3 - Ejecucion deterministica).

Uso:
    python execution/validate-schema.py <archivo.json> <schema>

Donde <schema> es uno de: raffle | numbers | draw

Valida que el contenido publico NO contenga datos sensibles:
  - documento, telefono, correo, direccion, comprobante (imagen) estan prohibidos.
  - el comprador se publica solo como "Nombre + Inicial del apellido".

Dependencias:
    pip install jsonschema

Salida:
    - Codigo 0 si OK.
    - Codigo 1 si hay error de validacion o se detectan campos prohibidos.
    - Codigo 2 si hay error de uso (argumentos/archivos).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SCHEMAS_DIR = Path(__file__).resolve().parent.parent / "packages" / "schemas"

# Campos prohibidos en cualquier JSON publico (privacidad por diseno).
FORBIDDEN_KEYS = {
    "documento", "document", "cedula", "phone", "telefono", "celular",
    "email", "correo", "address", "direccion", "receipt", "comprobante",
    "receipt_url", "comprobante_url", "image", "foto", "wompi_transaction_id",
    "ip", "device", "apellido_completo", "full_name",
}


def load_json(path: Path) -> object:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def find_forbidden(obj, path: str = "$") -> list[str]:
    """Recorre recursivamente el JSON buscando claves prohibidas."""
    hits: list[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            current = f"{path}.{key}"
            if key.lower() in FORBIDDEN_KEYS:
                hits.append(current)
            hits.extend(find_forbidden(value, current))
    elif isinstance(obj, list):
        for idx, value in enumerate(obj):
            hits.extend(find_forbidden(value, f"{path}[{idx}]"))
    return hits


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("Uso: python validate-schema.py <archivo.json> <raffle|numbers|draw>")
        return 2

    file_path = Path(argv[1])
    schema_name = argv[2].lower()
    schema_file = SCHEMAS_DIR / f"{schema_name}.schema.json"

    if schema_name not in {"raffle", "numbers", "draw"}:
        print(f"[ERROR] Schema desconocido: {schema_name}")
        return 2
    if not file_path.is_file():
        print(f"[ERROR] No existe el archivo: {file_path}")
        return 2
    if not schema_file.is_file():
        print(f"[ERROR] No existe el schema: {schema_file}")
        return 2

    try:
        data = load_json(file_path)
        schema = load_json(schema_file)
    except json.JSONDecodeError as exc:
        print(f"[ERROR] JSON invalido en {file_path}: {exc}")
        return 1

    # 1) Privacidad por diseno: campos prohibidos.
    forbidden = find_forbidden(data)
    if forbidden:
        print("[FAIL] Campos PROHIBIDOS detectados (datos sensibles en JSON publico):")
        for hit in forbidden:
            print(f"   - {hit}")
        return 1

    # 2) Validacion estructural contra JSON Schema.
    try:
        import jsonschema  # type: ignore
    except ImportError:
        print("[WARN] 'jsonschema' no instalado. Instala con: pip install jsonschema")
        print("[WARN] Se ejecuto solo el chequeo de privacidad (campos prohibidos).")
        return 0

    validator = jsonschema.Draft7Validator(schema)
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
    if errors:
        print(f"[FAIL] Validacion de schema '{schema_name}' fallo:")
        for err in errors:
            loc = ".".join(str(p) for p in err.path) or "$"
            print(f"   - {loc}: {err.message}")
        return 1

    print(f"[OK] '{file_path.name}' valida contra '{schema_name}' y no expone datos sensibles.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
