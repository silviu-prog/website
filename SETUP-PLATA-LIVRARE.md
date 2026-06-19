# YESHUA — Configurare plată Stripe + livrare Easybox (Sameday)

Acest document descrie tot ce trebuie configurat ca să funcționeze comanda cu
**plată prin Stripe** (card) și **livrare prin Sameday Easybox** (cu AWB generat
automat după plată, sau imediat pentru ramburs).

> ⚠️ **Important:** integrarea Sameday folosește **API-ul Sameday** (credențiale
> de tip API), NU loginul tău din portalul web / Chrome. Credențialele API se
> obțin din contul tău Sameday (sau de la account manager) și se pun ca variabile
> de mediu în Cloudflare — nu se introduc în browser.

---

## 1. Variabile de mediu / secrete (Cloudflare Pages)

Cloudflare Dashboard → proiectul Pages → **Settings → Environment variables**
(setează-le pentru *Production* și, dacă vrei să testezi, și pentru *Preview*).

| Variabilă | Tip | Descriere |
|---|---|---|
| `ADMIN_USERNAME` | text | utilizator panou `/admin` |
| `ADMIN_PASSWORD` | secret | parolă panou `/admin` |
| `STRIPE_SECRET_KEY` | secret | `sk_live_...` (sau `sk_test_...` la testare) |
| `STRIPE_WEBHOOK_SECRET` | secret | `whsec_...` (vezi pasul 3) |
| `SAMEDAY_USERNAME` | secret | user API Sameday |
| `SAMEDAY_PASSWORD` | secret | parolă API Sameday |
| `SAMEDAY_PICKUP_POINT_ID` | text | id punct de ridicare (vezi pasul 4) |
| `SAMEDAY_SERVICE_ID` | text | id serviciu Easybox / LockerNextDay (vezi pasul 4) |
| `SAMEDAY_CONTACT_PERSON_ID` | text | *(opțional)* id persoană de contact la pickup |
| `SAMEDAY_API_URL` | text | *(opțional)* implicit `https://api.sameday.ro`; sandbox: `https://sameday-api.demo.zitec.com` |
| `SAMEDAY_PACKAGE_WEIGHT` | text | *(opțional)* greutate colet în kg (implicit `1`) |
| `SITE_ORIGIN` | text | *(opțional)* ex. `https://yeshuabook.com` |

Binding D1 (deja existent): **`DB`**.

---

## 2. Migrarea bazei de date

Pentru baze **existente**, adaugă coloanele noi:

```bash
wrangler d1 execute <NUME_DB> --remote --file=migrations/0002_stripe_sameday.sql
```

Pentru o bază **nouă**, `schema.sql` conține deja totul.

---

## 3. Webhook Stripe

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. URL: `https://yeshuabook.com/api/stripe/webhook`
3. Evenimente: `checkout.session.completed` (și opțional
   `checkout.session.async_payment_succeeded`).
4. Copiază **Signing secret** (`whsec_...`) în `STRIPE_WEBHOOK_SECRET`.

La confirmarea plății, Worker-ul marchează comanda `paid` și **generează automat
AWB-ul Sameday** pentru cărțile fizice.

---

## 4. Găsirea ID-urilor Sameday (serviciu + pickup point)

După ce ai setat `SAMEDAY_USERNAME`/`SAMEDAY_PASSWORD`, loghează-te în `/admin`
și deschide în browser:

```
/api/admin/sameday/diagnostics
```

(trebuie să fii autentificat ca admin — folosește un client cu header
`X-Admin-Token: user:parola`, sau cere-mi un buton în panou).

Răspunsul îți arată:
- `auth: true/false` — dacă autentificarea API merge,
- `services` — lista serviciilor cu `id` (alege-l pe cel Easybox / locker),
- `pickupPoints` — punctele tale de ridicare cu `id`.

Pune `id`-ul serviciului Easybox în `SAMEDAY_SERVICE_ID` și id-ul punctului de
ridicare în `SAMEDAY_PICKUP_POINT_ID`.

---

## 5. Fluxul comenzii

1. Client → `/checkout` → alege format, date, **Easybox**, metodă de plată.
2. **Card:** comanda se salvează `pending`, e creată o sesiune Stripe Checkout,
   clientul plătește, webhook-ul confirmă → AWB automat.
3. **Ramburs:** comanda se salvează, AWB-ul e creat imediat (cu `cashOnDelivery`
   = total). Clientul plătește cash la ridicarea din Easybox.
4. `/admin` → vezi statusul plății, lockerul, AWB-ul; poți **regenera AWB** manual
   dacă a eșuat.

---

## 6. De verificat în producție (test live)

Nu am putut testa apelurile live (nu am credențiale). După ce setezi secretele,
verifică pe rând:

- [ ] `/api/lockers` întoarce lista de lockere (altfel ajustăm maparea câmpurilor
      în `normalizeLocker`).
- [ ] `/api/admin/sameday/diagnostics` → `auth: true` și vezi servicii + pickup points.
- [ ] O comandă **test** cu cardul (`sk_test_...`) → AWB apare în `/admin`.
- [ ] Dacă AWB-ul eșuează, mesajul de eroare Sameday apare în comandă; pe baza lui
      ajustăm câmpurile din `createSamedayAwb` (ex. `oohLastMile` vs `lockerLastMile`,
      sau formatul `awbRecipient`) pentru contul tău.
