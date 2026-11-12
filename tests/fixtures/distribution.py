"""Synthetic release archives; no user profiles, real sessions or executable processes."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import zipfile

root = Path(sys.argv[1])
mode = sys.argv[2]
project = Path(__file__).resolve().parents[2]
contract = json.loads((project / 'scripts/distribution-files.json').read_text())
version = '0.1.0'
if mode == 'create':
    for name in ['app', 'plugin', 'vendor/resources', 'out/desktop', 'packages/dsh-plugin']:
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / 'package.json').write_text(json.dumps({'version': version}))
    pkg = json.loads((project / 'packages/dsh-plugin/package.json').read_text())
    (root / 'packages/dsh-plugin/package.json').write_text(json.dumps(pkg))
    for name in contract['appFiles']:
        target = root / 'app' / name
        target.write_bytes((project / 'packages/dsh-plugin/assets/logo-48.png').read_bytes() if name.endswith('.png') else b'Synthetic fixture')
    (root / 'app/package.json').write_text(json.dumps({'name': 'agent-site', 'version': version, 'main': 'main.cjs', 'private': True, 'license': 'MIT'}))
    (root / 'app/THIRD-PARTY-NOTICES.txt').write_text('\n'.join(contract['bundledLicenses']))
    for name in contract['pluginFiles']:
        target = root / 'plugin' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        source = project / 'packages/dsh-plugin' / name
        target.write_bytes(source.read_bytes() if source.exists() and name != 'package.json' else b'Synthetic fixture')
    pkg.pop('devDependencies', None)
    (root / 'plugin/package.json').write_text(json.dumps(pkg))
    (root / 'vendor/electron.exe').write_bytes(b'MZ synthetic executable')
    (root / 'vendor/LICENSE').write_text('Synthetic runtime license')
    (root / 'vendor/resources/default_app.asar').write_bytes(b'Synthetic default app')
else:
    archive = root / 'out/desktop' / f'agent-site-{version}-win-x64.zip'
    manifest = {'product': 'agent-site', 'version': version, 'platform': 'win32', 'arch': 'x64', 'launchProtocol': 1}
    if mode == 'manifest':
        manifest['version'] = '9.9.9'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(root / 'vendor/electron.exe', 'AgentSite.exe')
        z.write(root / 'vendor/LICENSE', 'LICENSE.electron.txt')
        z.write(root / 'app.asar', 'resources/app.asar')
        z.writestr('agent-site.json', json.dumps(manifest))
        for name in ['INSTALL.md', 'INSTALL.zh-CN.md', 'THIRD-PARTY-NOTICES.txt']:
            z.write(root / 'app' / name, name)
        z.write(root / 'app/LICENSE', 'LICENSE.agent-site.txt')
        if mode == 'extra':
            z.writestr('settings.json', '{"synthetic": true}')
        if mode == 'extra-directory':
            z.writestr('synthetic-profile/', b'')
    if mode == 'plugin':
        p = root / 'plugin/package.json'
        pkg = json.loads(p.read_text()); pkg['scripts'] = {'install': 'echo unexpected'}; p.write_text(json.dumps(pkg))
    plugin = root / 'out' / f'dsh-agent-site-{version}.tgz'
    with tarfile.open(plugin, 'w:gz') as t:
        for name in contract['pluginFiles']:
            data = (root / 'plugin' / name).read_bytes()
            info = tarfile.TarInfo('package/' + name); info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    if mode == 'truncated':
        data = plugin.read_bytes(); plugin.write_bytes(data[:len(data) // 2])
    if mode == 'invalid-deflate':
        data = bytearray(plugin.read_bytes()); start = 10
        if data[3] & 8:
            start = data.index(0, start) + 1
        data[start] = (data[start] & ~6) | 6
        plugin.write_bytes(data)
    lines = [hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name for p in [archive, plugin]]
    if mode == 'checksum':
        lines[0] = '0' * 64 + lines[0][64:]
    (root / 'out/SHA256SUMS').write_text('\n'.join(lines) + '\n')
