# Gallinas y Valientes example

The `faq.md` and `instructions.md` in this directory are synthetic placeholder business context. They are **not** verified restaurant details. Do not publish them to clients without fact checking.

Example project:

```powershell
npm.cmd run falco:new -- --name falco-gallinas --business "Gallinas y Valientes" --provider mock --origin http://localhost:3000 --faq .\examples\gallinas\faq.md --instructions .\examples\gallinas\instructions.md --deploy
```

This demo is independent of the repository at https://github.com/GTL-AI-SAS/Gallinas-Valientes-Demo. No frontend or GitHub integration is performed.


## v1.1 client-action example

`actions.json` enables only `demo.open` with `option` enum `01`, `02`, `03`. Edit Manage Existing → Client actions to enable it on an existing Worker; export a new kit after deployment. The website agent must wire a deterministic local handler. No other permissions are granted.
