const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'dmuxzxeiu',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors());
app.use(express.json());

// ─── INSTAGRAM ───────────────────────────────────────────
app.post('/post/instagram', async (req, res) => {
  try {
    const { caption, imageUrl, imageUrls, mediaItems, accessToken, userId } = req.body;

    // Build a unified list of { url, type } items
    let items = [];
    if (mediaItems && mediaItems.length > 0) {
      items = mediaItems;
    } else if (imageUrls && imageUrls.length > 0) {
      items = imageUrls.map(u => ({ url: u, type: 'image' }));
    } else {
      items = [{ url: imageUrl, type: 'image' }];
    }

    console.log('Instagram post, item count:', items.length, items.map(i => i.type));

    // ─── SINGLE ITEM ───
    if (items.length === 1) {
      const item = items[0];
      const isVideo = item.type === 'video';
      const upload = await cloudinary.uploader.upload(item.url, { resource_type: isVideo ? 'video' : 'image' });
      const publicUrl = upload.secure_url;
      console.log('Cloudinary URL:', publicUrl);

      const containerPayload = isVideo
        ? { media_type: 'REELS', video_url: publicUrl, caption: caption, access_token: accessToken }
        : { image_url: publicUrl, caption: caption, access_token: accessToken };

      const containerRes = await axios.post(
        `https://graph.instagram.com/v18.0/${userId}/media`,
        containerPayload
      );
      const containerId = containerRes.data.id;

      if (isVideo) {
        await waitForFinished(containerId, accessToken);
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }

      const publishRes = await axios.post(
        `https://graph.instagram.com/v18.0/${userId}/media_publish`,
        { creation_id: containerId, access_token: accessToken }
      );
      return res.json({ success: true, postId: publishRes.data.id });
    }

    // ─── CAROUSEL (multiple items, photo/video/mixed) ───
    const childIds = [];
    for (const item of items) {
      const isVideo = item.type === 'video';
      const upload = await cloudinary.uploader.upload(item.url, { resource_type: isVideo ? 'video' : 'image' });

      const childPayload = isVideo
        ? { media_type: 'VIDEO', video_url: upload.secure_url, is_carousel_item: true, access_token: accessToken }
        : { image_url: upload.secure_url, is_carousel_item: true, access_token: accessToken };

      const childRes = await axios.post(
        `https://graph.instagram.com/v18.0/${userId}/media`,
        childPayload
      );
      const childId = childRes.data.id;

      if (isVideo) {
        await waitForFinished(childId, accessToken);
      }

      childIds.push(childId);
    }

    await new Promise(r => setTimeout(r, 5000));

    const parentRes = await axios.post(
      `https://graph.instagram.com/v18.0/${userId}/media`,
      { media_type: 'CAROUSEL', children: childIds.join(','), caption: caption, access_token: accessToken }
    );
    const parentId = parentRes.data.id;
    await new Promise(r => setTimeout(r, 5000));

    const publishRes = await axios.post(
      `https://graph.instagram.com/v18.0/${userId}/media_publish`,
      { creation_id: parentId, access_token: accessToken }
    );
    res.json({ success: true, postId: publishRes.data.id });

  } catch (error) {
    console.error('Instagram error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// Helper: poll a container until video processing finishes
async function waitForFinished(containerId, accessToken) {
  let status = 'IN_PROGRESS';
  let attempts = 0;
  while (status === 'IN_PROGRESS' && attempts < 30) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await axios.get(
      `https://graph.instagram.com/v18.0/${containerId}?fields=status_code&access_token=${accessToken}`
    );
    status = statusRes.data.status_code;
    console.log('Container', containerId, 'status:', status, 'attempt', attempts);
    attempts++;
  }
  if (status !== 'FINISHED') {
    throw new Error('Video processing failed or timed out. Status: ' + status);
  }
}


// ─── TIKTOK ───────────────────────────────────────────────
app.post('/post/tiktok', async (req, res) => {
  try {
    const { accessToken, videoUrl, caption } = req.body;

    const response = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: caption,
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error('TikTok error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── X (TWITTER) - Ready when credits added ───────────────
app.post('/post/twitter', async (req, res) => {
  res.json({ success: false, message: 'X API credits not yet activated' });
});



// ─── THREADS ──────────────────────────────────────────────
app.post('/post/threads', async (req, res) => {
  try {
    const { caption, imageUrl, accessToken, userId } = req.body;

    // Step 1: Create media container
    const containerRes = await axios.post(
      `https://graph.threads.net/v1.0/${userId}/threads`,
      {
        media_type: imageUrl ? 'IMAGE' : 'TEXT',
        image_url: imageUrl || undefined,
        text: caption,
        access_token: accessToken,
      }
    );

    const containerId = containerRes.data.id;

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Publish
    const publishRes = await axios.post(
      `https://graph.threads.net/v1.0/${userId}/threads_publish`,
      {
        creation_id: containerId,
        access_token: accessToken,
      }
    );

    res.json({ success: true, postId: publishRes.data.id });
  } catch (error) {
    console.error('Threads error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// — PRIVACY POLICY —
app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h1>Outpost Privacy Policy</h1>
        <p>Outpost collects your Instagram account information solely to enable posting on your behalf. We do not sell or share your data with third parties.</p>
        <p>You can revoke access at any time through your Instagram settings.</p>
        <p>Contact: bowenjumanne@gmail.com</p>
      </body>
    </html>
  `);
});

app.get('/auth/instagram/login', (req, res) => {
  console.log('Instagram login route hit');
  const authUrl = `https://api.instagram.com/oauth/authorize?client_id=920676630923363&redirect_uri=https://focuspost-server-production.up.railway.app/auth/instagram/callback&scope=instagram_business_basic,instagram_business_content_publish&response_type=code`;
  console.log('Redirecting to:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/instagram/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenRes = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
        client_id: '920676630923363',
        client_secret: process.env.INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: 'https://focuspost-server-production.up.railway.app/auth/instagram/callback',
        code: code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;
        const userRes = await axios.get(
          `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${access_token}`
        );
        const username = userRes.data.username;
        const userId = userRes.data.id;
        res.redirect(`outpost://auth?token=${access_token}&userId=${userId}&username=${username}`);
          } catch (error) {
            console.error('Instagram callback error:', error.response?.data || error.message);
            res.redirect('outpost://auth?error=login_failed');
          }
        });

   

// ─── TIKTOK AUTH ──────────────────────────────────────────
app.get('/auth/tiktok/login', (req, res) => {
 const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload&response_type=code&redirect_uri=https://focuspost-server-production.up.railway.app/auth/tiktok/callback&state=outpost`;
  res.redirect(authUrl);
});

app.get('/auth/tiktok/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenRes = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: 'https://focuspost-server-production.up.railway.app/auth/tiktok/callback',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, open_id } = tokenRes.data;
    res.redirect(`outpost://auth/tiktok?token=${access_token}&userId=${open_id}`);
  } catch (error) {
    console.error('TikTok auth error:', error.response?.data || error.message);
    res.redirect('outpost://auth/tiktok?error=login_failed');
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'FocusPost server is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FocusPost server running on port ${PORT}`);
});
