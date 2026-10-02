# Sourced (hidden) at the start of docs/demo.tape: `npx leakfix` runs leakfix
# against the simulated cloud from scripts/demo.ts, in a fresh demo repo.
export PS1='\[\e[2m\]~/my-api\[\e[0m\] $ '
npx() { shift; /src/node_modules/.bin/tsx /src/scripts/demo.ts "$@"; }
/src/node_modules/.bin/tsx /src/scripts/demo.ts setup
cd /tmp/leakfix-demo/my-api
