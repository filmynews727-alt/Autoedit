# AutoEdit AI — Real Backend (FFmpeg + AssemblyAI)

Yeh tumhare frontend (autoedit-ai.html) ke saath connect hone wala real
processing server hai. Isme actual video cutting, silence detection, aur
caption generation hoti hai — jo pehle sirf simulate ho raha tha.

## Step 1 — AssemblyAI key lo (free)

1. https://www.assemblyai.com/dashboard/signup pe account banao
2. Dashboard se API key copy karo
3. `.env.example` ko `.env` naam se copy karo, us key ko `ASSEMBLYAI_API_KEY=` ke aage paste karo

## Step 1b — Cloudinary lo (free) — permanent video storage ke liye

Iske bina, tumhari processed videos server ke local disk pe save hoti hain,
aur **server restart hote hi delete ho jaati hain** (Render free plan pe ye
khud-ba-khud bhi ho sakta hai). Cloudinary in videos ko permanently, kahin
bhi accessible rakhta hai.

1. https://cloudinary.com/users/register/free pe free account banao
2. Signup ke baad seedha "Dashboard" khulega — wahan teen cheezein milengi
   ek saath: **Cloud Name**, **API Key**, **API Secret**
3. Teeno ko `.env` file mein paste karo:
   - `CLOUDINARY_CLOUD_NAME=`
   - `CLOUDINARY_API_KEY=`
   - `CLOUDINARY_API_SECRET=`

Agar ye teeno set nahi karoge, app phir bhi chalega — bas videos permanent
nahi rahengi.

## Step 1c — Security key banao (recommended)

Ye ensure karta hai ki koi random bot/script tumhare live link ko dhundh ke
seedha use na kar paye (bina tumhari website khole).

1. Koi bhi lamba random text bana lo (jaise keyboard pe 20+ characters mash
   kar do) — ye tumhara secret password hai
2. `.env` mein `APP_SECRET_KEY=` ke aage paste karo
3. Apni `autoedit-ai.html` file mein `BACKEND_APP_KEY` constant mein **wahi
   exact same value** paste karo (Ctrl+F se "BACKEND_APP_KEY" dhundo)
4. Netlify pe naya file upload karna mat bhoolna is change ke baad

> Ye security hamesha ke liye foolproof nahi hai — jo bhi tumhari website ka
> code dekhega, wo ye key nikaal sakta hai (frontend code mein koi secret
> chhupa hi nahi sakta, kisi bhi website mein). Par ye casual bots/scanners
> ko rok deta hai jo bina tumhari site khole seedha API link try karte hain —
> jo asli duniya mein sabse zyada hone wala attack hai.

## Step 1d — Real login banao (Firebase Authentication, free)

Abhi tak signup/login sirf dikhawa tha — koi bhi fake email daal ke andar aa
sakta tha. Firebase se ye asli ban jayega: real password check, real Google
sign-in, aur real "forgot password" email.

**A) Firebase project banao:**
1. https://console.firebase.google.com pe jao, Google se login karo
2. "Add project" → koi bhi naam do (jaise "autoedit-ai") → baaki defaults
   rakhke "Create project" dabao

**B) Login methods on karo:**
3. Left menu mein "Build" → "Authentication" → "Get started"
4. "Sign-in method" tab mein **"Email/Password"** ko enable karo
5. Usi jagah **"Google"** ko bhi enable karo (support email pooch सकता hai —
   apna email daal do)

**C) Web app config lo (frontend ke liye):**
6. Project ke home page pe **"</>"** (web) icon dabao → app ka koi naam do →
   "Register app"
7. Ek code block dikhega jisme `apiKey`, `authDomain`, `projectId`, `appId`
   honge — inko `autoedit-ai.html` file mein `FIREBASE_CONFIG` object mein
   paste karo (Ctrl+F se "FIREBASE_CONFIG" dhundo)

**D) Service account lo (backend ke liye):**
8. ⚙️ (gear icon) → "Project settings" → "Service accounts" tab
9. "Generate new private key" dabao — ek `.json` file download hogi
10. Us poori file ko text editor mein kholo, sara content copy karo
11. Render ke Environment mein `FIREBASE_SERVICE_ACCOUNT_JSON` naam se ek
    variable banao aur wahi poora JSON paste kar do (ek hi line mein)

Bas — ab signup/login/Google/forgot-password sab **asli** honge, aur backend
bhi verify karega ki request ek real logged-in user se aa rahi hai.

> Agar Firebase set up nahi karoge, app phir bhi chalega — signup/login
> "demo mode" mein rahega (jaisा pehle tha, sirf naam/email save hota hai,
> koi asli verification nahi).

## Step 1e — Firestore banao (free) — presets/videos ka real database

Ab tak presets/videos sirf tumhare phone ke browser mein save the — doosre
device se login karne pe kuch nahi dikhta tha. Firestore se ye tumhare
account se judke, kahin se bhi dikhega.

1. https://console.firebase.google.com pe apne pehle wale project mein jao
2. Left menu mein "Build" → "Firestore Database" → "Create database"
3. "Start in production mode" choose karo → koi bhi region select karo → "Enable"

**Zaroori — Security Rules set karo:** "Production mode" ka matlab hai
by-default **sab kuch band** hota hai, jab tak tum khud rules nahi likhte.
Bina is step ke, presets/videos save hi nahi honge (silently fail ho jayenge).

4. Firestore Database page pe **"Rules"** tab pe jao
5. Jo bhi likha hai usse hata ke ye paste karo:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Har user apna hi data padh/likh sakta hai
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    // Koi bhi logged-in user feedback/support message BHEJ sakta hai,
    // par sirf tum (admin) unhe PADH sakte ho
    match /feedback/{docId} {
      allow create: if request.auth != null;
      allow read: if request.auth != null && request.auth.token.email == "your-admin-email@example.com";
    }
    match /supportMessages/{docId} {
      allow create: if request.auth != null;
      allow read: if request.auth != null && request.auth.token.email == "your-admin-email@example.com";
    }
  }
}
```

6. `"your-admin-email@example.com"` ki jagah apna wahi email daalo jo
   `ADMIN_EMAIL` mein bhi daala hai (dono jagah same hona chahiye)
7. **"Publish"** dabao

## Step 1f — Cloudinary unsigned upload (music/logo/intro/outro ke liye)

Ye Brand Kit page se seedha browser se Cloudinary pe file upload karne deta
hai (bina backend se guzre), taaki music/logo/intro/outro clips attach ho
sakein.

1. https://cloudinary.com/console pe apne (Step 1b wale) account mein jao
2. ⚙️ (Settings) → "Upload" tab → "Upload presets" section → "Add upload preset"
3. "Signing Mode" ko **"Unsigned"** kar do → Save
4. Us preset ka naam copy karo
5. `autoedit-ai.html` file mein `CLOUDINARY_CLOUD_NAME` aur
   `CLOUDINARY_UPLOAD_PRESET` constants mein apna Cloud Name (Step 1b se) aur
   ye naya preset naam paste karo (Ctrl+F se dhundo)

## Step 1g — OpenAI lo (paid, but bahut sasta) — AI caption/image ke liye

Ye "AI-Generated Thumbnail Image", real video-content-based captions, aur
standalone **Poster Generator** (shop banners/posters) ko power karta hai.

1. https://platform.openai.com pe account banao
2. Settings → Billing mein card add karo (isme free trial nahi hai, per-use
   charge hai — ek caption+image ki cost paise ke bhi 1 rupee se kam hoti hai)
3. https://platform.openai.com/api-keys pe jaake naya key banao
4. `.env` mein `OPENAI_API_KEY=` ke aage paste karo

Agar ye set nahi karoge, baaki sab kuch chalega — bas ye specific 3 features
(AI image, content-aware caption, Poster Generator) kaam nahi karenge.

## Step 1h — Email notifications banao (free, Resend)

Jab video ready ho, user ko email jayega — bina isके user ko screen pe wait
karna padta hai.

1. https://resend.com pe free account banao
2. https://resend.com/api-keys pe naya key banao
3. `.env` mein `RESEND_API_KEY=` ke aage paste karo

> Bina apna domain verify kiye, Resend sirf tumhare **apne signup wale email**
> pe bhej payega (testing ke liye theek hai). Har user ko bhejna ho toh
> Resend mein apna domain verify karna hoga (agar Maurya Tech ka koi domain
> hai, wahi use kar sakte ho) — `NOTIFY_FROM_EMAIL` mein us domain wala
> address daal dena.

## Step 1i — Payments (Razorpay) — jab business account ban jaye

Ye maine sirf **code ready** kiya hai — chalu karne ke liye tumhara khud ka
verified Razorpay business account chahiye (KYC ke saath), jo Anthropic ya
Claude nahi bana sakte.

1. https://razorpay.com pe business account banao, KYC complete karo
2. https://dashboard.razorpay.com/app/keys se API keys lo
3. `.env` mein `RAZORPAY_KEY_ID` aur `RAZORPAY_KEY_SECRET` paste karo

Jab tak ye set nahi hoga, "Switch plan" button clear error dikhayega ("Payments
are not set up yet") — koi crash nahi hoga.

## Step 1j — AI Voiceover (ElevenLabs) — optional

Ye "Voice Enhancement"/"Noise Reduction" toggles ko bhi real banata hai (pehle
ye sirf UI mein the, kuch karte nahi the — ab genuine FFmpeg audio filters
lagte hain), aur ek naya "AI Voiceover" feature bhi deta hai jo kamzor/noisy
audio ko clean AI narration se replace kar deta hai.

1. https://elevenlabs.io pe account banao
2. https://elevenlabs.io/app/settings/api-keys se key lo
3. `.env` mein `ELEVENLABS_API_KEY=` ke aage paste karo

> Voice IDs hardcode nahi kiye hain — ElevenLabs apni purani "Default
> voices" hata raha hai (Dec 2026 tak khatam), isliye app tumhare account
> mein jo bhi voices available hain unhi ki live list dikhata hai (preset
> builder ke "Sound" step mein, jab AI Voiceover on karoge).

> Ye full lip-sync nahi hai — voiceover-style content (narration, tutorials)
> ke liye best hai, close-up talking-head videos ke liye nahi.

## Step 1k — Admin Dashboard set up karo (1000 users test karne se pehle zaroori)

Ye ek hi jagah dikhata hai: kitni videos process hui, AssemblyAI ka kitna
free quota use hua, OpenAI/ElevenLabs kitna use hua, aur abhi server pe
kitna load hai — taaki baar-baar 5 alag dashboards check na karne padein.

1. `.env` mein `ADMIN_EMAIL=` ke aage apna wahi email daalo jisse tum
   AutoEdit AI mein login karte ho
2. Bas — login karne ke baad sidebar mein "Admin" link dikhega (sirf tumhe,
   kisi aur ko nahi — backend bhi email check karta hai, sirf link chhupana
   nahi)

## Concurrency (ek saath kitne log test kar sakte hain)

Transcription (AssemblyAI/OpenAI/ElevenLabs) sab log ek saath kar sakte hain
— ye external APIs ka wait hai, tumhare server ka CPU nahi khaata. Sirf
**asli video render** (FFmpeg) ek time pe limited number mein hota hai,
taaki free/chhota server crash na ho.

- `MAX_CONCURRENT_RENDERS=1` (default) — Render free tier ke liye safe
- Render ka paid plan (zyada CPU/RAM) lene ke baad, isse 2-3 kar sakte ho
- Zyada set karne se pehle Render ka **Metrics** tab check karo — agar CPU
  already 100% ke paas hai 1 render mein, zyada concurrent renders isse aur
  crash karwa sakte hain

**1000 users ek saath test karna:** Sabko turant upload karne dega, aur
transcription/AI steps sab ke liye parallel chalenge — bas render step ki
line lagegi (jitna `MAX_CONCURRENT_RENDERS` ho). Real "1000 log same second
mein full result paayein" ke liye paid Render plan + zyada concurrency
chahiye hoga — Admin dashboard mein "Server Load" dekh ke pata chal jayega
kab upgrade karna hai.

## Step 2 — Local mein test karo (optional but recommended)

```bash
cd autoedit-backend
npm install
npm start
```

Server `http://localhost:8080` pe chalega. FFmpeg system mein install hona
chahiye — agar `ffmpeg: command not found` error aaye:
- Windows: https://ffmpeg.org/download.html se download karke PATH mein add karo
- Mac: `brew install ffmpeg`

## Step 3 — Deploy karo (Render.com — free tier available)

1. Is `autoedit-backend` folder ko ek naye GitHub repo mein push karo
2. https://render.com pe jao → "New Web Service" → apna repo select karo
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment variables mein ye sab add karo:
   - `ASSEMBLYAI_API_KEY`
   - `FRONTEND_URL` (tumhara Netlify URL, jaise `https://autoedit-ai.netlify.app`)
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (Step 1b se)
   - `APP_SECRET_KEY` (Step 1c se)
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (Step 1d se)
   - `OPENAI_API_KEY` (Step 1g se)
   - `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` (Step 1h se)
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (Step 1i se, jab business account ban jaye)
   - `ELEVENLABS_API_KEY` (Step 1j se, optional)
   - `ADMIN_EMAIL`, `MAX_CONCURRENT_RENDERS` (Step 1k se)
6. Deploy — kuch minute mein tumhe ek URL milega jaisे
   `https://autoedit-ai-backend.onrender.com`

> Render ka free tier FFmpeg pehle se support karta hai — kuch extra install
> nahi karna padega.

## Step 4 — Frontend ko connect karo

Apni `autoedit-ai.html` file mein `startAutoEdit()` function dhundo. Usme
jo simulated processing hai, use replace karo real API calls se:

```js
async function startAutoEdit(){
  const preset = getPresets().find(p => p.id === uploadState.presetId);

  const formData = new FormData();
  formData.append('file', uploadState.file);
  formData.append('presetJson', JSON.stringify(preset));

  const res = await fetch('https://autoedit-ai-backend.onrender.com/api/videos/upload', {
    method: 'POST',
    body: formData,
  });
  const { jobId } = await res.json();

  navigate(`/processing/${jobId}`);
  pollJobStatus(jobId); // naya function — neeche
}

function pollJobStatus(jobId){
  const iv = setInterval(async () => {
    const res = await fetch(`https://autoedit-ai-backend.onrender.com/api/jobs/${jobId}/status`);
    const job = await res.json();

    // yahi wahi progress-bar/stage-label elements hain jo pehle se tumhare
    // processing screen mein hain — bas ab real data se update honge
    const bar = document.getElementById('progress-bar');
    const pct = document.getElementById('progress-pct');
    const label = document.getElementById('stage-label');
    if (bar) bar.style.width = job.progress + '%';
    if (pct) pct.textContent = job.progress + '%';
    if (label) label.textContent = job.stage;

    if (job.status === 'done') {
      clearInterval(iv);
      // job.outputUrl real processed video ka link hai
      navigate(`/preview/${jobId}?video=${encodeURIComponent(job.outputUrl)}`);
    }
    if (job.status === 'failed') {
      clearInterval(iv);
      toast('Processing failed: ' + job.error, 'error');
    }
  }, 1500);
}
```

## Kya real hai, kya abhi bhi baaki hai

| Feature | Is backend mein | Status |
|---|---|---|
| Silence detection | AssemblyAI word-timing se | ✅ Real |
| Auto captions (SRT) | AssemblyAI transcript se | ✅ Real |
| Cuts/trim | FFmpeg select filter | ✅ Real |
| Ratio/resolution | FFmpeg scale/crop | ✅ Real |
| Captions burn-in | FFmpeg subtitles filter | ✅ Real |
| Logo overlay | FFmpeg overlay filter | ✅ Real (agar logo file path do) |
| Color Grading | FFmpeg eq/curves/colorbalance filters | ✅ Real |
| Auto Thumbnail Picker | FFmpeg's `thumbnail` frame-scoring filter | ✅ Real |
| Hook Optimizer | FFmpeg astats loudness analysis + reorder | ✅ Real (loudness-based heuristic) |
| Auto Zoom / Punch-ins | FFmpeg crop-based zoom on hook window | ✅ Real |
| Beat Sync | Simple energy-peak onset detection | ⚠️ Approximate — not a full music beat-tracker; works okay on steady rhythms, drifts on complex tracks |
| Trending Sound Match | Curated static library, matched by duration | ⚠️ Suggestion only — no public "what's trending now" API exists; you must license/attach the actual audio file yourself |
| Music mixing | FFmpeg amix, music file from Brand Kit (Cloudinary) | ✅ Real |
| Intro/Outro | Second FFmpeg pass — scale/pad/concat with core render | ✅ Real |
| Text Overlay (CTA) | FFmpeg drawtext | ✅ Real |
| Cloud storage | Cloudinary | ✅ Real (Step 1b) |
| Database (presets/videos/Brand Kit) | Firestore | ✅ Real (Step 1e) |
| Job queue | In-process, concurrency=1 | ✅ Real — prevents overlapping renders crashing a free server |
| Usage limits (plan quotas) | Firestore-backed monthly counter | ✅ Real — no-op if Firestore isn't set up |
| AI Viral Caption (content-aware) | OpenAI reads the real transcript | ✅ Real — needs OPENAI_API_KEY |
| AI-Generated Thumbnail Image | OpenAI image generation | ✅ Real — needs OPENAI_API_KEY |
| Poster/Banner Generator (standalone) | Same OpenAI engine, no video needed | ✅ Real — needs OPENAI_API_KEY |
| Multi-Platform Export | Re-renders per extra ratio in the same job | ✅ Real |
| Email notifications | Resend | ✅ Real — needs RESEND_API_KEY (sandbox limits apply without a verified domain) |
| Payments | Razorpay order + signature verification | ✅ Code ready — needs your own verified Razorpay account (KYC) to actually go live |
| Voice Enhancement / Noise Reduction | FFmpeg afftdn, EQ, compressor | ✅ Real (was UI-only before, now actually applied) |
| AI Voiceover | ElevenLabs TTS, replaces original audio | ✅ Real — needs ELEVENLABS_API_KEY. Not full lip-sync — best for narration-style content |
| Admin Usage Dashboard | Firestore-backed counters across all services | ✅ Real — needs ADMIN_EMAIL set |
| In-app Feedback + Support form | Firestore, no phone number needed | ✅ Real — visible to you on /admin (needs Firestore rules from Step 1e) |
| Transition Sound Effects (Whoosh) | Synthesized live by FFmpeg (no sound file) | ✅ Real — no new account needed. Works best with Hook Optimizer/Auto Zoom on |
| Hook-timing bug fix | Zoom/whoosh now use output-timeline coordinates | ✅ Fixed — previously Auto Zoom could land in the wrong spot after Hook Optimizer reordered the video |
| Concurrent processing (multiple users) | Transcription runs freely; renders queue via MAX_CONCURRENT_RENDERS | ✅ Real |
| Memes/Sticker overlay | FFmpeg drawtext at detected pause points | ✅ Real, with a caveat — emoji render using whatever font the server resolves, usually monochrome (not full-color) unless a color-emoji font is installed on the machine |
| Filler Word Removal | AssemblyAI transcript + FFmpeg cuts | ✅ Real — cuts "um", "uh", "matlab", "like" etc. the same way silence is cut |
| Speed Ramping | Per-segment FFmpeg setpts/atempo + concat | ✅ Real — speeds up any kept segment longer than the threshold |
| Karaoke word-highlight captions | Real .ass subtitle file (libass \\kf tags) | ✅ Real |
| Loudness Normalization | FFmpeg loudnorm (EBU R128) | ✅ Real |

## Agla step

Sab kuch code-level ready hai. Sirf ek cheez baaki hai jo main nahi bana sakta:
**Payments live karna** — iske liye tumhara khud ka verified Razorpay
business account chahiye (neeche "Payments" section dekho). Baaki sab
(multi-platform export, email notifications, AI captions/images, poster
generator) already kaam kar raha hai jaise hi unki API key `.env` mein daal
doge. Beat Sync ko zyada accurate banana ho toh ek dedicated beat-tracking
library (jaise Python `librosa` ek chhoti helper service ke roop mein) add
karna sabse bada baaki upgrade hoga.

## Payments (Razorpay) — jab ready ho

Code taiyar hai (`services/payments.js`, `/api/payments/create-order` aur
`/api/payments/verify` routes, frontend checkout). Chalu karne ke liye
tumhara khud ka verified business account chahiye (bina uske koi bhi test
payment link kaam nahi karega). Jab tumhara Razorpay account ban jaye:

1. Razorpay Dashboard se API keys lo
2. `.env` mein `RAZORPAY_KEY_ID` aur `RAZORPAY_KEY_SECRET` paste karo
3. Render "Save, rebuild, and deploy" dabao

Bas — code already ready hai (`services/payments.js`, routes, aur frontend
checkout sab already implemented hain), keys daalte hi Subscription page ke
"Switch plan" buttons real Razorpay checkout khol denge.
