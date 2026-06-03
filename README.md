# YESHUA

Site de prezentare și vânzare a cărții **Yeshua**, găzduit pe **Cloudflare Pages**
cu un backend `_worker.js` (Pages Function) și o bază de date **D1** pentru comenzi.

- Producție: https://yeshua.pages.dev
- Domeniu: https://yeshuabook.com

## Structură

| Fișier | Rol |
|---|---|
| `index.html` | Pagina principală (landing) |
| `checkout.html` | Formular de comandă |
| `thank-you.html` | Pagina de confirmare |
| `admin.html` | Panou de administrare comenzi (login protejat) |
| `_worker.js` | Backend: creare comenzi + API admin |
| `schema.sql` | Schema tabelei `orders` (D1) |
| `deploy.example.ps1` | Șablon de deploy (citește token-ul din variabilă de mediu) |

## Configurare Cloudflare Pages

Variabile / binding-uri necesare în proiectul Pages (Settings → Functions / Environment):

| Nume | Tip | Descriere |
|---|---|---|
| `DB` | D1 binding | Legat la baza de date `yeshua-orders` |
| `ADMIN_USERNAME` | Secret/Variable | Utilizatorul panoului de admin |
| `ADMIN_PASSWORD` | **Secret** | Parola panoului de admin (folosește una lungă, aleatorie) |

> Parola de admin este și cheia cu care se semnează token-ul de sesiune.
> Dacă o schimbi, toate sesiunile active de admin devin invalide automat.

## Deploy

1. Copiază `deploy.example.ps1` în `deploy.ps1` (acesta din urmă este ignorat de git).
2. Setează token-ul în sesiunea PowerShell:
   ```powershell
   $env:CF_API_TOKEN = "token-ul-tau-cloudflare"
   ```
3. Rulează:
   ```powershell
   ./deploy.ps1
   ```

## Securitate

Măsuri implementate în backend:

- **Prețuri calculate pe server** — prețurile trimise de client sunt ignorate;
  serverul folosește catalogul propriu (anti-manipulare a totalului).
- **Validare strictă a intrărilor** — produs, cantitate (1–100), monedă forțată `RON`,
  câmpuri de client/livrare validate.
- **Autentificare admin cu token semnat (HMAC-SHA256)** — parola nu mai este
  stocată în browser; token-ul expiră după 12h.
- **Comparare în timp constant** a credențialelor (anti timing-attack).
- **Rate limiting** (best-effort) la `/api/orders` și `/api/admin/login`.
- **Security headers** pe toate răspunsurile: CSP, HSTS, X-Frame-Options,
  X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
- **Prepared statements** pentru toate interogările D1 (anti SQL injection).

### De făcut manual (recomandat)

- Regenerează periodic token-ul Cloudflare; nu îl pune niciodată în fișiere urmărite de git.
- Activează **Cloudflare WAF → Rate Limiting Rules** pentru protecție robustă la
  nivel de rețea (în plus față de rate limiting-ul din cod).
- Păstrează repository-ul **privat**.
