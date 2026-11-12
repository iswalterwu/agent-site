"""Read-only release artifact gate. Uses Python's standard library; never uploads."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import struct
import sys
import tarfile
import zipfile

CONTRACT = json.loads(Path(__file__).with_name('distribution-files.json').read_text(encoding='utf-8'))
EXTRAS = {'agent-site.json', 'LICENSE.agent-site.txt', 'THIRD-PARTY-NOTICES.txt', 'INSTALL.md', 'INSTALL.zh-CN.md', 'resources/app.asar'}
PRIVACY = [
    re.compile(r'(?:[A-Z]:[/\\](?:Users|20\d\d)[/\\]|/(?:Users|home)/[A-Za-z0-9_.-]+)', re.I),
    re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})\b'),
    re.compile(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'),
    re.compile(r'''(?:api[_-]?key|(?:access|auth)[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["']([^"'\s]{8,})["']''', re.I),
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private_text(data, scope):
    text = data.decode('utf-8').replace('\\\\', '\\')
    require(not any(rule.search(text) for rule in PRIVACY), f'{scope}: private path or credential pattern')
    return text


def safe_names(names, scope):
    require(len(names) == len(set(names)), f'{scope}: duplicate file')
    for name in names:
        path = PurePosixPath(name)
        require(not path.is_absolute() and '..' not in path.parts and '\\' not in name and ':' not in name, f'{scope}: unsafe archive path')


def asar_files(data):
    require(len(data) >= 16, 'Desktop ASAR header is missing')
    header_size = struct.unpack_from('<I', data, 4)[0]
    json_size = struct.unpack_from('<I', data, 12)[0]
    require(16 + json_size <= 8 + header_size <= len(data), 'Desktop ASAR header is invalid')
    files = json.loads(data[16:16 + json_size])['files']
    require(set(files) == set(CONTRACT['appFiles']), 'Desktop ASAR file allowlist mismatch')
    result = {}
    for name, info in files.items():
        require(not any(key in info for key in ['files', 'link', 'unpacked']), 'Desktop ASAR contains external content')
        start = 8 + header_size + int(info['offset'])
        end = start + info['size']
        require(8 + header_size <= start <= end <= len(data), 'Desktop ASAR file is truncated')
        result[name] = data[start:end]
    return result


def png(data, name):
    require(data[:8] == b'\x89PNG\r\n\x1a\n', f'{name}: not a PNG')
    require(len(data) <= (10000 if 'logo-' in name else 120000), f'{name}: image exceeds size budget')
    chunks = []
    at = 8
    while at + 12 <= len(data):
        size = struct.unpack_from('>I', data, at)[0]
        chunks.append(data[at + 4:at + 8])
        at += size + 12
    require(at == len(data) and chunks[-1:] == [b'IEND'], f'{name}: invalid PNG chunks')
    require(not set(chunks) & {b'tEXt', b'zTXt', b'iTXt', b'eXIf'}, f'{name}: private image metadata')
    sizes = {'logo-48.png': (48, 48), 'logo-96.png': (96, 96), 'logo-192.png': (192, 192), 'scene-1x.png': (420, 268), 'scene-2x.png': (840, 536)}
    if PurePosixPath(name).name in sizes:
        require(struct.unpack_from('>II', data, 16) == sizes[PurePosixPath(name).name], f'{name}: image dimensions mismatch')


def check_desktop(archive, vendor, version):
    runtime = {}
    for file in vendor.rglob('*'):
        if not file.is_file():
            continue
        name = file.relative_to(vendor).as_posix()
        if name == 'resources/default_app.asar':
            continue
        runtime[{'electron.exe': 'AgentSite.exe', 'LICENSE': 'LICENSE.electron.txt'}.get(name, name)] = file
    require('AgentSite.exe' in runtime and 'LICENSE.electron.txt' in runtime, 'Windows Electron runtime is unavailable')
    with zipfile.ZipFile(archive) as z:
        all_entries = z.infolist()
        entries = [item for item in all_entries if not item.is_dir()]
        names = [item.filename for item in entries]
        safe_names([item.filename for item in all_entries], 'Desktop ZIP')
        allowed = set(runtime) | EXTRAS
        directories = {str(parent) for name in allowed for parent in PurePosixPath(name).parents if str(parent) != '.'}
        require(set(names) == allowed and all(item.filename.rstrip('/') in directories for item in all_entries if item.is_dir()), 'Desktop ZIP file allowlist mismatch')
        require(all((item.external_attr >> 16) & 0o170000 != 0o120000 for item in all_entries), 'Desktop ZIP contains a link')
        for name, original in runtime.items():
            if name != 'AgentSite.exe':
                with z.open(name) as stream, original.open('rb') as source:
                    require(hashlib.file_digest(stream, 'sha256').digest() == hashlib.file_digest(source, 'sha256').digest(), 'Electron runtime file mismatch')
        manifest = json.loads(z.read('agent-site.json'))
        require(manifest == {'product': 'agent-site', 'version': version, 'platform': 'win32', 'arch': 'x64', 'launchProtocol': 1}, 'Desktop launch manifest mismatch')
        app = asar_files(z.read('resources/app.asar'))
        pkg = json.loads(app['package.json'])
        require(pkg.get('name') == 'agent-site' and pkg.get('version') == version and pkg.get('main') == 'main.cjs' and pkg.get('private') is True, 'Desktop package identity mismatch')
        for name, data in app.items():
            if name.endswith('.png'):
                png(data, name)
            else:
                private_text(data, 'Desktop/' + name)
        for name in ['INSTALL.md', 'INSTALL.zh-CN.md', 'THIRD-PARTY-NOTICES.txt']:
            require(z.read(name) == app[name], 'Desktop documentation differs from packaged source')
        require(z.read('LICENSE.agent-site.txt') == app['LICENSE'], 'Desktop project license mismatch')
        notices = app['THIRD-PARTY-NOTICES.txt'].decode('utf-8')
        require(all(name in notices for name in CONTRACT['bundledLicenses']), 'Bundled dependency notices are incomplete')


def check_plugin(archive, version):
    with tarfile.open(archive, 'r:gz') as t:
        all_entries = t.getmembers()
        entries = [item for item in all_entries if not item.isdir()]
        names = [item.name for item in entries]
        safe_names([item.name for item in all_entries], 'Plugin TGZ')
        require(all(item.isfile() or item.isdir() for item in all_entries), 'Plugin TGZ contains a link or special entry')
        allowed = {'package/' + name for name in CONTRACT['pluginFiles']}
        directories = {str(parent) for name in allowed for parent in PurePosixPath(name).parents if str(parent) != '.'}
        require(set(names) == allowed and all(item.name.rstrip('/') in directories for item in all_entries if item.isdir()), 'Plugin TGZ file allowlist mismatch')
        files = {item.name.removeprefix('package/'): t.extractfile(item).read() for item in entries}
    pkg = json.loads(files['package.json'])
    require(pkg.get('name') == 'dsh-agent-site' and pkg.get('version') == version, 'Plugin package identity mismatch')
    require(pkg.get('engines', {}).get('dsh') == '0.2.1-rc.3 || 0.2.2-rc.1', 'Plugin compatibility declaration mismatch')
    require(not pkg.get('scripts') and not pkg.get('devDependencies') and not pkg.get('dependencies'), 'Plugin contains install scripts or private runtime dependencies')
    require(pkg.get('dsh', {}).get('bundle', {}).get('patch') == './cordis.patch.yml', 'Plugin bundle patch is missing')
    require(pkg.get('icon') == 'assets/logo-192.png' and pkg.get('exports', {}).get('./icon') == './assets/logo-192.png', 'Plugin icon entry mismatch')
    for name, data in files.items():
        if name.endswith('.png'):
            png(data, name)
        else:
            private_text(data, 'Plugin/' + name)
    for name in json.loads(files['screenshots.json']):
        require(name.startswith('assets/') and name in files and name.endswith('.png'), 'Plugin screenshot is not a local bundled image')


def check(artifacts, vendor):
    version = json.loads(Path('package.json').read_text(encoding='utf-8'))['version']
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:-[\w.-]+)?', version), 'Invalid release version')
    archives = [artifacts / 'desktop' / f'agent-site-{version}-win-x64.zip', artifacts / f'dsh-agent-site-{version}.tgz']
    require(all(file.is_file() for file in archives), 'Both current-version ZIP and TGZ are required')
    sums = (artifacts / 'SHA256SUMS').read_text(encoding='utf-8').splitlines()
    expected = {file.name: hashlib.file_digest(file.open('rb'), 'sha256').hexdigest() for file in archives}
    require(len(sums) == len(expected), 'Checksum file must list exactly the current ZIP and TGZ')
    actual = {}
    for line in sums:
        match = re.fullmatch(r'([0-9a-f]{64})  ([^/\\]+)', line)
        require(match is not None, 'Checksum entries must use downloadable basenames')
        actual[match[2]] = match[1]
    require(actual == expected, 'Archive checksum mismatch')
    check_desktop(archives[0], vendor, version)
    check_plugin(archives[1], version)
    return {'version': version, 'artifacts': expected, 'checks': 'allowlists, identities, licenses, media, privacy patterns'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, default=Path('dist/distribution'))
    parser.add_argument('--vendor', type=Path, default=Path('node_modules/electron/dist'))
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.artifacts, args.vendor), ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, EOFError, struct.error, zipfile.BadZipFile, tarfile.TarError, UnicodeError):
        error = sys.exc_info()[1]
        message = str(error) if type(error) is ValueError else 'Malformed archive or metadata'
        print('Distribution check failed: ' + message, file=sys.stderr)
        sys.exit(1)
    except OSError:
        print('Distribution check failed: required source, archive or runtime file is unavailable', file=sys.stderr)
        sys.exit(1)
