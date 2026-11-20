"""Launch this application's trusted command with explicit BWS references."""
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
DEFAULT=['node', 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1']

def main():
    args=sys.argv[1:]
    client_commands={'mc-cli.cjs','mc-tui.cjs','mc-mcp-server.cjs'}
    client_launch=(args[:2]==['--exec','node'] and len(args)>2
                   and Path(args[2]).name in client_commands)
    default_manifest=ROOT/'config'/('glas.cli.local.json' if client_launch else 'glas.local.json')
    manifest=Path(os.environ.get('GLAS_MANIFEST', default_manifest))
    candidates=[Path(os.environ['GLAS_ROOT'])] if os.environ.get('GLAS_ROOT') else [p/n for p in ROOT.parents for n in ('lugos/glas','glas')]
    glas=next((p for p in candidates if (p/'src/glas/cli.py').is_file()),None)
    if not manifest.is_file():
        print('Glas reference manifest is missing.',file=sys.stderr)
        return 1
    python=ROOT/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    app_python=str(python) if python.is_file() else sys.executable
    if args[:1] not in (['--exec'],['--start'],['--standalone']):
        if subprocess.call(['node', 'scripts/check-node-version.mjs'], cwd=ROOT) != 0:
            return 1
        args=['--port', os.environ.get('PORT', '3000'), *args]
    if args[:1]==['--exec']:
        command=args[1:]
    elif args[:1]==['--start']:
        command=['node','node_modules/next/dist/bin/next','start','--hostname','0.0.0.0','--port',os.environ.get('PORT','3000'),*args[1:]]
    elif args[:1]==['--standalone']:
        command=['node',str(ROOT/'.next/standalone/server.js')]
    else:
        command=[app_python if x=='{python}' else x for x in DEFAULT]+args
    if not command:
        print('Supply a trusted command after --exec.',file=sys.stderr)
        return 2
    env=os.environ.copy()
    for name in tuple(env):
        upper=name.upper()
        if upper=='BWS_ACCESS_TOKEN' or upper.endswith(('_TOKEN','_SECRET','_PASSWORD','_API_KEY','_CLIENT_SECRET')) or upper in ('AUTH_PASS','API_KEY'):
            env.pop(name,None)
    if 'GLAS_HOME' not in env and glas is not None:
        env['GLAS_HOME']=str(glas/'.glas')
    sources=[]
    if glas is not None:
        sources.append(str(glas/'src'))
    if env.get('PYTHONPATH'):
        sources.append(env['PYTHONPATH'])
    if sources:
        env['PYTHONPATH']=os.pathsep.join(sources)
    command=[c[:-4] if os.name!='nt' and c in ('npm.cmd','pnpm.cmd') else c for c in command]
    glas_python=os.environ.get('GLAS_PYTHON') or (str(glas/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')) if glas is not None else sys.executable)
    workdir=ROOT/'.next/standalone' if args[:1]==['--standalone'] else ROOT
    return subprocess.call([glas_python,'-m','glas','run','--manifest',str(manifest),'--',*command],cwd=workdir,env=env)

if __name__=='__main__':
    raise SystemExit(main())
