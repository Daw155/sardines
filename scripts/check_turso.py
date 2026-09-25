"""Optional live connection check. Requires exported Turso environment variables."""
import os
from pathlib import Path
import secrets
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from storage import StoreUnavailable, TursoStore


def main():
    url, token = os.getenv('TURSO_DATABASE_URL'), os.getenv('TURSO_AUTH_TOKEN')
    if not url or not token:
        raise StoreUnavailable('Export TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first.')
    store = TursoStore(url, token)
    # Outside the room-code alphabet, so this cannot overlap a real game.
    code = '__check__' + secrets.token_hex(16)
    created = False
    try:
        created = store.create(code, {'value': 1})
        if not created:
            raise StoreUnavailable('Could not create the temporary check row.')
        if store.update(code, lambda room: room['value']) != 1:
            raise StoreUnavailable('Could not read the temporary check row.')
        store.update(code, lambda room: room.update(value=2))
        if store.update(code, lambda room: room['value']) != 2:
            raise StoreUnavailable('Could not update the temporary check row.')
    finally:
        if created:
            store._execute('DELETE FROM sardines_rooms WHERE code = ?', (code,))
    print('Turso connection, schema, reads, writes, and cleanup passed.')


if __name__ == '__main__':
    try:
        main()
    except StoreUnavailable as exc:
        print(f'Turso check failed: {exc}', file=sys.stderr)
        sys.exit(1)
