#!/usr/bin/env python3
"""Local-only upstream Keycloak/PostgreSQL TLS integration fixture. Never a public deployment."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

REPOSITORY = Path(__file__).resolve().parent.parent
POSTGRES_IMAGE = 'postgres@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac'
IMAGE = 'quill-identity-integration'
LABEL = 'org.quill.identity-integration'
PHASE = 'initialization'
DOCKER_ENV = {k: v for k, v in os.environ.items() if k not in {
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}


def docker(*args, data=None, capture=False):
    try:
        result = subprocess.run(['docker', '--host=unix:///var/run/docker.sock', *args],
                            env=DOCKER_ENV, input=data, check=True,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        # This build only references public pinned image/configuration. Other
        # commands may process private SQL/env inputs and must not echo stderr.
        if args[0] == 'build':
            print('Public pinned-image build diagnostic:', error.stderr.decode(errors='replace')[-3000:], flush=True)
        raise
    return result.stdout.decode().strip() if capture else None


def phase(value):
    global PHASE
    PHASE = value
    print('Identity fixture phase: ' + value, flush=True)


def write_private(path, contents):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        handle.write(contents)


def stop(state_path):
    if not state_path.exists():
        return
    state = json.loads(state_path.read_text())
    nonce = state['nonce']
    if not re.fullmatch('[a-f0-9]{16}', nonce):
        raise RuntimeError('Invalid local fixture identity')
    base = 'quill-idp-test-' + nonce
    root = Path(state['root'])
    if root.is_symlink() or not root.name.startswith(base + '-') or root.stat().st_uid != os.getuid():
        raise RuntimeError('Unsafe local fixture directory')
    for name in [base, base + '-db']:
        try:
            label = docker('inspect', '--format', '{{index .Config.Labels "' + LABEL + '"}}', name, capture=True)
        except subprocess.CalledProcessError:
            continue
        if label != nonce:
            raise RuntimeError('Refusing to remove a container outside this fixture')
        docker('rm', '-fv', name)
    try:
        label = docker('network', 'inspect', '--format', '{{index .Labels "' + LABEL + '"}}', base, capture=True)
        if label != nonce:
            raise RuntimeError('Refusing to remove a network outside this fixture')
        docker('network', 'rm', base)
    except subprocess.CalledProcessError:
        pass
    shutil.rmtree(root)
    state_path.unlink()
    print('Stopped and removed this local identity fixture.')


def start(state_path):
    if state_path.exists() or os.getuid() == 0:
        raise RuntimeError('Use an unused state path and an ordinary development user')
    nonce = secrets.token_hex(8)
    base = 'quill-idp-test-' + nonce
    root = Path(tempfile.mkdtemp(prefix=base + '-'))
    root.chmod(0o700)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    state = {'nonce': nonce, 'root': str(root), 'issuer': f'https://localhost:{port}/realms/quill',
             'port': port, 'network': base, 'postgres': base + '-db', 'container': base}
    write_private(state_path, json.dumps(state))

    def write(name, contents):
        path = root / name
        write_private(path, contents)
        return path

    def openssl(*args):
        subprocess.run(['openssl', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def certificate(name, subject, san=None):
        if san is None:
            openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(root / (name + '.key')),
                    '-out', str(root / (name + '.crt')), '-subj', subject, '-days', '2',
                    '-addext', 'basicConstraints=critical,CA:TRUE',
                    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
                    '-addext', 'subjectKeyIdentifier=hash')
        else:
            openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(root / (name + '.key')),
                    '-out', str(root / (name + '.csr')), '-subj', subject)
            extension = write(name + '.ext', 'subjectAltName=' + san + '\nbasicConstraints=critical,CA:FALSE\n'
                              'keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'
                              'subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
            openssl('x509', '-req', '-in', str(root / (name + '.csr')), '-CA', str(root / 'ca.crt'),
                    '-CAkey', str(root / 'ca.key'), '-CAcreateserial', '-out', str(root / (name + '.crt')),
                    '-days', '2', '-extfile', str(extension))
        (root / (name + '.key')).chmod(0o600)

    try:
        phase('local Docker health')
        docker('info')
        phase('pinned provider image build')
        docker('build', '--tag', IMAGE, str(REPOSITORY / 'deploy/identity'))
        phase('private TLS and client configuration')
        certificate('ca', '/CN=Quill local integration CA')
        certificate('server', '/CN=localhost', 'DNS:localhost,IP:127.0.0.1')
        certificate('postgres', '/CN=quill-idp-db', 'DNS:quill-idp-db')
        previous_ca = os.environ.get('NODE_EXTRA_CA_CERTS')
        trust = (Path(previous_ca).read_text() + '\n') if previous_ca else ''
        write('client-ca.pem', trust + (root / 'ca.crt').read_text())
        credentials = {key: secrets.token_hex(32) for key in ['admin', 'user', 'postgres', 'database']}
        write('secrets.json', json.dumps(credentials))
        write('civic.secret', secrets.token_hex(32))
        write('charter.secret', secrets.token_hex(32))
        environment = {**os.environ, 'CIVIC_PUBLIC_ORIGIN': 'https://localhost:9444',
                       'CHARTER_PUBLIC_ORIGIN': 'https://localhost:9445',
                       'CIVIC_OIDC_CLIENT_SECRET_FILE': str(root / 'civic.secret'),
                       'CHARTER_OIDC_CLIENT_SECRET_FILE': str(root / 'charter.secret')}
        subprocess.run(['node', str(REPOSITORY / 'deploy/identity/realm.mjs'), str(root / 'quill-realm.json')],
                       env=environment, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        write('postgres.env', 'POSTGRES_PASSWORD=' + credentials['postgres'] + '\n')
        write('pg_hba.conf', 'local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\n'
              'hostssl all all ::0/0 scram-sha-256\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::0/0 reject\n')
        docker('network', 'create', '--label', LABEL + '=' + nonce, base)
        phase('isolated TLS PostgreSQL startup')
        postgres_start = (
            'cp /run/fixture/pg_hba.conf /tmp/pg_hba.conf; '
            'cp /run/fixture/postgres.key /tmp/server.key; cp /run/fixture/postgres.crt /tmp/server.crt; '
            'chown postgres:postgres /tmp/pg_hba.conf /tmp/server.key /tmp/server.crt; '
            'chmod 600 /tmp/pg_hba.conf /tmp/server.key; '
            'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt '
            '-c ssl_key_file=/tmp/server.key -c ssl_min_protocol_version=TLSv1.3 '
            '-c ssl_max_protocol_version=TLSv1.3 -c hba_file=/tmp/pg_hba.conf')
        docker('run', '-d', '--name', base + '-db', '--label', LABEL + '=' + nonce,
               '--network', base, '--network-alias', 'quill-idp-db', '--env-file', str(root / 'postgres.env'),
               '--mount', f'type=bind,src={root},dst=/run/fixture,readonly',
               '--entrypoint', '/bin/sh', POSTGRES_IMAGE, '-c', postgres_start)
        for _ in range(60):
            try:
                # The entrypoint's initialization server accepts Unix-socket
                # connections before restarting. Only the final server listens on TCP.
                docker('exec', base + '-db', 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres')
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        else:
            raise RuntimeError('Local TLS PostgreSQL did not become ready')
        phase('isolated TLS PostgreSQL role provisioning')
        sql = (f"CREATE ROLE keycloak LOGIN PASSWORD '{credentials['database']}' NOSUPERUSER NOCREATEDB "
               "NOCREATEROLE NOREPLICATION NOBYPASSRLS;\nCREATE DATABASE keycloak OWNER keycloak;\n")
        docker('exec', '-i', base + '-db', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', data=sql.encode())
        phase('TLS provider startup')
        write('keycloak.env', '\n'.join([
            f'KC_HOSTNAME=https://localhost:{port}',
            'KC_HTTPS_CERTIFICATE_FILE=/run/tls/server.crt', 'KC_HTTPS_CERTIFICATE_KEY_FILE=/run/tls/server.key',
            'KC_DB_URL=jdbc:postgresql://quill-idp-db:5432/keycloak?sslmode=verify-full&sslrootcert=/run/tls/ca.crt',
            'KC_DB_USERNAME=keycloak', 'KC_DB_PASSWORD=' + credentials['database'],
            'KC_BOOTSTRAP_ADMIN_USERNAME=quillbootstrap', 'KC_BOOTSTRAP_ADMIN_PASSWORD=' + credentials['admin'],
            'JAVA_OPTS_APPEND=-Djdk.tls.client.protocols=TLSv1.3']) + '\n')
        docker('run', '-d', '--name', base, '--label', LABEL + '=' + nonce, '--network', base,
               '--user', f'{os.getuid()}:0', '--memory', '2g',
               '--tmpfs', f'/opt/keycloak/data:uid={os.getuid()},gid={os.getgid()},mode=0700',
               '-p', f'127.0.0.1:{port}:8443', '--env-file', str(root / 'keycloak.env'),
               '--mount', f'type=bind,src={root},dst=/run/tls,readonly',
               '--mount', f'type=bind,src={root}/quill-realm.json,dst=/opt/keycloak/data/import/quill-realm.json,readonly', IMAGE)
        print('Started local identity fixture; waiting for verified TLS discovery.', flush=True)
        phase('verified TLS discovery')
        context = ssl.create_default_context(cafile=str(root / 'ca.crt'))
        context.verify_flags |= ssl.VERIFY_X509_STRICT
        context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
        for _ in range(120):
            try:
                with urllib.request.urlopen(state['issuer'] + '/.well-known/openid-configuration',
                                            context=context, timeout=2) as response:
                    metadata = json.load(response)
                if metadata['issuer'] != state['issuer']:
                    raise RuntimeError('Provider issuer mismatch')
                break
            except (OSError, ValueError) as error:
                reason = getattr(error, 'reason', error)
                if isinstance(reason, ssl.SSLCertVerificationError):
                    raise RuntimeError('Fixture certificate rejected by strict verification') from None
                time.sleep(1)
        else:
            raise RuntimeError('Local identity provider did not become ready')
        version = docker('exec', base + '-db', 'psql', '-U', 'postgres', '-tAc',
                         "SELECT string_agg(DISTINCT version, ',') FROM pg_stat_ssl s JOIN pg_stat_activity a USING(pid) WHERE a.usename='keycloak'", capture=True)
        if version != 'TLSv1.3':
            raise RuntimeError('Provider database TLS version mismatch')
        origin = state['issuer'].split('/realms/')[0]
        phase('local integration-user provisioning')
        body = urllib.parse.urlencode({'grant_type': 'password', 'client_id': 'admin-cli',
                                       'username': 'quillbootstrap', 'password': credentials['admin']}).encode()
        with urllib.request.urlopen(urllib.request.Request(origin + '/realms/master/protocol/openid-connect/token', data=body),
                                    context=context, timeout=20) as response:
            admin_token = json.load(response)['access_token']
        body = json.dumps({'username': 'quillfixture', 'enabled': True, 'firstName': 'Local', 'lastName': 'Fixture',
                           'email': 'quillfixture@example.invalid', 'emailVerified': False,
                           'credentials': [{'type': 'password', 'value': credentials['user'], 'temporary': False}],
                           'requiredActions': ['CONFIGURE_TOTP']}).encode()
        request = urllib.request.Request(origin + '/admin/realms/quill/users', data=body, method='POST',
                                         headers={'Authorization': 'Bearer ' + admin_token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, context=context, timeout=20) as response:
            if response.status != 201:
                raise RuntimeError('Could not create local integration user')
        print('Verified provider discovery and PostgreSQL use TLS 1.3; local test user provisioned.', flush=True)
    except Exception:
        # Only emit bounded failure evidence, with fixture credentials removed.
        sensitive = list(locals().get('credentials', {}).values())
        for name in ['civic.secret', 'charter.secret']:
            if (root / name).exists():
                sensitive.append((root / name).read_text().strip())
        if locals().get('admin_token'):
            sensitive.append(admin_token)
        for name in [base, base + '-db']:
            result = subprocess.run(['docker', '--host=unix:///var/run/docker.sock', 'inspect', '--format',
                                     'running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}', name],
                                    env=DOCKER_ENV, capture_output=True, text=True)
            if result.returncode != 0:
                continue
            detail = 'Identity fixture process: ' + result.stdout.strip()
            print(('::error::' if os.environ.get('GITHUB_ACTIONS') == 'true' else '') + detail, flush=True)
            logs = subprocess.run(['docker', '--host=unix:///var/run/docker.sock', 'logs', '--tail', '80', name],
                                  env=DOCKER_ENV, capture_output=True, text=True)
            text = logs.stdout + logs.stderr
            for value in sensitive:
                if value:
                    text = text.replace(value, '[redacted]')
            text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----', '[redacted key]', text, flags=re.S)
            for line in [line for line in text.splitlines() if any(word in line for word in
                         ['ERROR', 'FATAL', 'Exception', 'Permission denied', 'Key material'])][-5:]:
                message = 'Provider setup diagnostic: ' + line[:500]
                message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
                print(('::error::' if os.environ.get('GITHUB_ACTIONS') == 'true' else '') + message, flush=True)
        stop(state_path)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--stop', action='store_true')
    args = parser.parse_args()
    try:
        stop(args.state) if args.stop else start(args.state)
    except Exception as error:
        message = 'Local identity fixture failed during ' + PHASE + ' (' + type(error).__name__ + '); credentials were not logged.'
        print(('::error::' if os.environ.get('GITHUB_ACTIONS') == 'true' else '') + message, flush=True)
        raise SystemExit(1)
