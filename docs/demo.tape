# Records docs/demo.gif against the simulated Atlas + Vercel (scripts/demo.ts).
# Re-record: docs/record-demo.sh

Output docs/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1340
Set Height 700
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "source /src/docs/demo-env.sh && clear" Enter
Sleep 3s
Show

Type "npx leakfix scan" Sleep 500ms Enter
Sleep 4500ms

Hide
Type "clear" Enter
Sleep 300ms
Show
Type "npx leakfix rotate --yes" Sleep 500ms Enter
Sleep 12s

Hide
Type "clear" Enter
Sleep 300ms
Show
Type "# the deploy failed, so leakfix put everything back. Fix it, then run again:" Sleep 1500ms Enter
Type "npx leakfix rotate --yes" Sleep 500ms Enter
Sleep 11s
