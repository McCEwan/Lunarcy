# Deploying Lunarcy

## What is live now (Nov 2026)

Azure **Free Trial** subscriptions can't use App Service (quota 0, request refused with
`ResourceNotAvailableForOffer`), so Lunarcy runs on a small VM instead:

| | |
|---|---|
| VM | `lunarcy-vm`, Ubuntu 24.04, Standard_B2ls_v2 (2 vCPU, 4 GB), **Canada East** (Canada Central had no capacity) |
| Resource group | `lunarcy-rg` (also holds storage account `lunarcydeploy2246`, used to ship the code) |
| Public IP | **20.104.186.227** (static) · `lunarcy-earth.canadaeast.cloudapp.azure.com` |
| Ports | 80 and 443 only; manage it with `az vm run-command invoke` (no SSH rule) |
| App | systemd service `lunarcy` → `startup.sh` (data in `/opt/lunarcy/data`), uvicorn on 127.0.0.1:8000 |
| HTTPS | Caddy reverse proxy, automatic Let's Encrypt certificates for `lunarcy.earth`, `www.lunarcy.earth` and the Azure name |
| Setup script | `scripts/setup_vm.sh` (run as root with `CODE_URL` set to a .tar.gz of the repo) |

**GoDaddy DNS** for lunarcy.earth: `A @ → 20.104.186.227` and `CNAME www → lunarcy-earth.canadaeast.cloudapp.azure.com`
(remove GoDaddy's parking/forwarding records).

**Update the site:** `git archive` the repo, upload it to the storage account, make a read-only SAS link,
and re-run `scripts/setup_vm.sh` with `CODE_URL` set to it (it keeps the Horizons cache and the data).

The App Service guide below still applies to a Pay-As-You-Go or student subscription.

---

## Option: Azure App Service

Lunarcy is a FastAPI server that also serves `web/`, so it needs a host that runs Python,
with persistent disk for the NASA data (~540 MB). Azure App Service (Linux) fits.

## 1. Create the web app

In portal.azure.com → **Create a resource → Web App**:

| Setting | Value |
|---|---|
| Publish | Code |
| Runtime stack | Python 3.12 |
| Operating system | Linux |
| Region | Canada Central (Toronto) |
| Pricing plan | Basic B1 (Free F1 is too small: 60 CPU min/day, 1 GB disk) |

## 2. Configure it

**Settings → Environment variables** (App settings):

| Name | Value | Why |
|---|---|---|
| `LUNAR_DATA_DIR` | `/home/data` | `/home` is persistent on App Service |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | installs `requirements.txt` on deploy |
| `WEBSITES_CONTAINER_START_TIME_LIMIT` | `1800` | first start downloads the NASA data |
| `LOLA_PPD` | `64` | 531 MB grid (~474 m); `128` = 2.1 GB (~237 m), needs more RAM |

**Settings → Configuration → Startup command:** `bash startup.sh`

`startup.sh` downloads NASA LOLA and builds the Diviner temperature grids into
`$LUNAR_DATA_DIR` the first time (a few minutes), then starts uvicorn on `$PORT`.
Later restarts skip the downloads.

## 3. Deploy the code

**Deployment Center → Source: GitHub →** repository `McCEwan/Lunarcy`, branch `main`.
Azure adds a GitHub Actions workflow that redeploys on every push.

Or from a terminal with the Azure CLI:

```bash
az login
az webapp up --name <app-name> --resource-group lunarcy-rg --location canadacentral \
  --runtime "PYTHON:3.12" --sku B1
az webapp config set -g lunarcy-rg -n <app-name> --startup-file "bash startup.sh"
az webapp config appsettings set -g lunarcy-rg -n <app-name> --settings \
  LUNAR_DATA_DIR=/home/data SCM_DO_BUILD_DURING_DEPLOYMENT=true \
  WEBSITES_CONTAINER_START_TIME_LIMIT=1800 LOLA_PPD=64
```

Open `https://<app-name>.azurewebsites.net/health`. When it shows LOLA as the elevation
source and `"temperature_loaded": true`, the data is in place. Then click through a few
demo sites so the JPL Horizons cache is warm before judging.

Optional (10–15 min, sharper finder and permanent-shadow grid): **SSH** into the app and run
`python scripts/build_skylines.py`, then restart.

## 4. Point lunarcy.earth at it

1. App Service → **Custom domains → Add custom domain** → `lunarcy.earth`.
   Azure shows an **A** record (the app's IP) and a **TXT** record `asuid` (verification code).
2. GoDaddy → My Products → lunarcy.earth → **DNS**:
   - Delete GoDaddy's parking A record for `@` (and any "Forwarding").
   - Add **A** `@` → the IP Azure shows.
   - Add **TXT** `asuid` → the code Azure shows.
   - For `www`: **CNAME** `www` → `<app-name>.azurewebsites.net`, plus **TXT** `asuid.www` → the same code.
3. Back in Azure, click **Validate**, then **Add**. DNS can take minutes to a few hours.
4. **Certificates → Add certificate → App Service Managed Certificate** for each domain, then
   **Bind** it (SNI SSL). `https://lunarcy.earth` is live.

## Costs

B1 is roughly US$13/month, paid from Azure credits. Set a budget alert under
**Cost Management**, and **Stop** the app when it isn't needed.
