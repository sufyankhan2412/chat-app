# Vercel Frontend Deployment Setup

## Quick Setup (5 minutes)

### 1. Add Environment Variables

Go to: [Vercel Dashboard](https://vercel.com/dashboard)

1. Select your project
2. Go to **Settings** → **Environment Variables**
3. Add these 5 variables:

```env
VITE_API_URL=https://chat-app-0aam.onrender.com/api
VITE_SOCKET_URL=https://chat-app-0aam.onrender.com
VITE_TURN_URLS=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:80?transport=tcp,turn:standard.relay.metered.ca:443,turns:standard.relay.metered.ca:443?transport=tcp
VITE_TURN_USERNAME=1dcb1a3f3c79b5b6c56bc144
VITE_TURN_CREDENTIAL=yMKsvaYuIvUiOOPQ
```

**Important:**
- Apply to: **Production**, **Preview**, and **Development**
- Click **Save** after each variable

### 2. Redeploy

**Option A: Git Push (Recommended)**
```bash
git add .
git commit -m "Fix: Add production environment variables"
git push origin main
```

**Option B: Manual Redeploy**
1. Go to **Deployments** tab
2. Click **⋯** on latest deployment
3. Click **Redeploy**

### 3. Test

Open: https://chat-app-pi-green-77.vercel.app/chat

✅ Login should work  
✅ Messages should load  
✅ Real-time updates work  
✅ Images load from Cloudinary  
✅ No 404 errors

---

## Common Issues

### WebSocket Connection Failed

**Symptom:**
```
WebSocket connection to 'wss://...' failed
```

**Fix:**
1. Check `VITE_SOCKET_URL` is set in Vercel
2. Value should be: `https://chat-app-0aam.onrender.com`
3. Redeploy after adding
4. Clear browser cache (Ctrl+Shift+R)

### 404 Errors

**Symptom:**
```
Failed to load resource: 404
```

**Fix:**
1. Check `VITE_API_URL` is set in Vercel
2. Value should be: `https://chat-app-0aam.onrender.com/api`
3. Redeploy
4. Hard refresh (Ctrl+Shift+R)

### CORS Errors

**Symptom:**
```
Access blocked by CORS policy
```

**Fix:**
Add to Render backend environment:
```
FRONTEND_URL=https://chat-app-pi-green-77.vercel.app
```

---

## Verify Environment Variables

After deployment, open browser console:

```javascript
console.log(import.meta.env.VITE_API_URL);
// Should output: "https://chat-app-0aam.onrender.com/api"

console.log(import.meta.env.VITE_SOCKET_URL);
// Should output: "https://chat-app-0aam.onrender.com"
```

If showing `undefined`, variables weren't added correctly.

---

## Files Reference

- `.env.production` - Production environment template
- `context/Socketcontext.jsx` - Updated with production fallback
- `api.js` - Updated with production fallback

---

Done! Your frontend should now connect to your backend correctly. 🚀
