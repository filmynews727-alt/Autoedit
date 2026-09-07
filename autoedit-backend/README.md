# AutoEdit AI — Real Backend (FFmpeg + AssemblyAI)

Yeh tumhare frontend (autoedit-ai.html) ke saath connect hone wala real
processing server hai. Isme actual video cutting, silence detection, aur
caption generation hoti hai — jo pehle sirf simulate ho raha tha.

## Step 1 — AssemblyAI key lo (free)

1. https://www.assemblyai.com/dashboard/signup pe account banao
2. Dashboard se API key copy karo
3. `.env.example` ko `.env` naam se copy karo, us key ko `ASSEMBLYAI_API_KEY=` ke aage paste karo

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
5. Environment variables mein `ASSEMBLYAI_API_KEY` aur `FRONTEND_URL`
   (tumhara Netlify URL, jaise `https://autoedit-ai.netlify.app`) add karo
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
| Music mixing | FFmpeg amix | ⚠️ Wire karna baaki — musicPath abhi null hai server.js mein |
| Cloud storage | — | ❌ Abhi local disk pe save hota hai, S3 add karna padega |
| Payments | — | ❌ Razorpay alag se add karna hoga |

## Agla step

Jab ye chal jaye, sabse pehle **music file upload + storage** wire karo
(server.js mein `musicPath`/`logoPath` variables), phir S3 add karo taaki
video sirf server ke disk pe na ho — kahin bhi access ho sake.
