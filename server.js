const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


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
    const { caption, imageUrl, imageUrls, mediaItems, accessToken, userId, mute } = req.body;

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
      const uploadOptions = { resource_type: isVideo ? 'video' : 'image' };
      if (isVideo && mute) {
        uploadOptions.transformation = [{ audio_codec: 'none' }];
      }
      const upload = await cloudinary.uploader.upload(item.url, uploadOptions);
      const publicUrl = upload.secure_url;

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

      const publishRes = await publishWithRetry(userId, containerId, accessToken);
      return res.json({ success: true, postId: publishRes.data.id });
    }

    // ─── CAROUSEL (multiple items, photo/video/mixed) ───
    const childResults = await Promise.all(
      items.map(async (item) => {
       const isVideo = item.type === 'video';
        const childUploadOptions = { resource_type: isVideo ? 'video' : 'image' };
        if (isVideo && mute) {
          childUploadOptions.transformation = [{ audio_codec: 'none' }];
        }
        const upload = await cloudinary.uploader.upload(item.url, childUploadOptions);

        const childPayload = isVideo
          ? { media_type: 'VIDEO', video_url: upload.secure_url, is_carousel_item: true, access_token: accessToken }
          : { image_url: upload.secure_url, is_carousel_item: true, access_token: accessToken };

        const childRes = await axios.post(
          `https://graph.instagram.com/v18.0/${userId}/media`,
          childPayload
        );
        return { id: childRes.data.id, isVideo };
      })
    );




    await Promise.all(
      childResults
        .filter(c => c.isVideo)
        .map(c => waitForFinished(c.id, accessToken))
    );

    const childIds = childResults.map(c => c.id);
    await new Promise(r => setTimeout(r, 3000));

    const parentRes = await axios.post(
      `https://graph.instagram.com/v18.0/${userId}/media`,
      { media_type: 'CAROUSEL', children: childIds.join(','), caption: caption, access_token: accessToken }
    );
    const parentId = parentRes.data.id;

    // Wait for the PARENT carousel container itself to finish before publishing
    await waitForFinished(parentId, accessToken);

    const publishRes = await publishWithRetry(userId, parentId, accessToken);
    res.json({ success: true, postId: publishRes.data.id });

  } catch (error) {
    console.error('Instagram error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── INSTAGRAM STORY (photo or video) ────────────────────
app.post('/post/instagram-story', async (req, res) => {
  try {
    const { imageUrl, mediaItems, accessToken, userId, mute} = req.body;

    // Determine the media and its type
    let mediaUrl = imageUrl;
    let isVideo = false;
    if (mediaItems && mediaItems.length > 0) {
      mediaUrl = mediaItems[0].url;
      isVideo = mediaItems[0].type === 'video';
    }

    console.log('Instagram story post, isVideo:', isVideo, 'url:', mediaUrl);

    // Upload to Cloudinary
    const uploadOptions = { resource_type: isVideo ? 'video' : 'image' };
    if (isVideo && mute) {
      uploadOptions.transformation = [{ audio_codec: 'none' }];
    }
    const upload = await cloudinary.uploader.upload(mediaUrl, uploadOptions);
    const publicUrl = upload.secure_url;

    // Create story container
    const containerPayload = isVideo
      ? { media_type: 'STORIES', video_url: publicUrl, access_token: accessToken }
      : { media_type: 'STORIES', image_url: publicUrl, access_token: accessToken };

    const containerRes = await axios.post(
      `https://graph.instagram.com/v18.0/${userId}/media`,
      containerPayload
    );
    const containerId = containerRes.data.id;

    // Videos need processing time, photos just need a brief wait
    if (isVideo) {
      await waitForFinished(containerId, accessToken);
    } else {
      await new Promise(r => setTimeout(r, 5000));
    }

    // Publish
    const publishRes = await publishWithRetry(userId, containerId, accessToken);
    res.json({ success: true, postId: publishRes.data.id });

  } catch (error) {
    console.error('Instagram story error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── GET USER'S MEDIA (list posts) ───────────────────────
app.get('/instagram/media', async (req, res) => {
  try {
    const { userId, accessToken } = req.query;
    const response = await axios.get(
      `https://graph.instagram.com/v18.0/${userId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,comments_count&access_token=${accessToken}`
    );
    res.json({ success: true, data: response.data.data });
  } catch (error) {
    console.error('Get media error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── GET COMMENTS ON A POST ──────────────────────────────
app.get('/instagram/comments', async (req, res) => {
  try {
const { mediaId, accessToken } = req.query;
  const response = await axios.get(
      `https://graph.instagram.com/v18.0/${mediaId}/comments?fields=id,text,username,timestamp&access_token=${accessToken}`
    );
    res.json({ success: true, data: response.data.data });
  } catch (error) {
    console.error('Get comments error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── REPLY TO A COMMENT ──────────────────────────────────
app.post('/instagram/reply', async (req, res) => {
  try {
    const { commentId, message, accessToken } = req.body;
    const response = await axios.post(
      `https://graph.instagram.com/v18.0/${commentId}/replies`,
      { message: message, access_token: accessToken }
    );
    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error('Reply error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

async function waitForFinished(containerId, accessToken) {
  let status = 'IN_PROGRESS';
  let attempts = 0;
  const maxAttempts = 40;
  while (status === 'IN_PROGRESS' && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await axios.get(
      `https://graph.instagram.com/v18.0/${containerId}?fields=status_code,status&access_token=${accessToken}`
    );
    status = statusRes.data.status_code;
    console.log('Container', containerId, 'status:', status, 'detail:', statusRes.data.status, 'attempt', attempts);
    attempts++;
  }
  if (status === 'ERROR') {
    throw new Error('Video processing failed. The video format may be unsupported.');
  }
  if (status !== 'FINISHED') {
    throw new Error('Video is taking longer than expected. Please try again in a moment.');
  }
}

async function publishWithRetry(userId, creationId, accessToken, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await axios.post(
        `https://graph.instagram.com/v18.0/${userId}/media_publish`,
        { creation_id: creationId, access_token: accessToken }
      );
    } catch (err) {
      const subcode = err.response?.data?.error?.error_subcode;
      console.log('Publish attempt', attempt, 'failed. Subcode:', subcode);
      if (subcode === 2207027 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}


// ─── TIKTOK ───────────────────────────────────────────────
app.post('/tiktok/creator-info', async (req, res) => {
  try {
    const { accessToken } = req.body;
    const response = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
      }
    );
    res.json({ success: true, data: response.data.data });
  } catch (error) {
    console.error('TikTok creator_info error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});


app.post('/post/tiktok', async (req, res) => {
  try {
    const {
      accessToken, videoUrl, caption,
      privacyLevel, disableComment, disableDuet, disableStitch,
      brandOrganic, brandedContent, aiGenerated,
    } = req.body;

    const fileRes = await axios.get(videoUrl, { responseType: 'arraybuffer', maxContentLength: Infinity, maxBodyLength: Infinity });
    const buffer = Buffer.from(fileRes.data);
    const videoSize = buffer.length;
    console.log('TIKTOK video bytes:', videoSize);

    const initRes = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: caption || '',
          privacy_level: privacyLevel || 'SELF_ONLY',
          disable_comment: !!disableComment,
          disable_duet: !!disableDuet,
          disable_stitch: !!disableStitch,
          brand_organic_toggle: !!brandOrganic,
          brand_content_toggle: !!brandedContent,
          is_aigc: !!aiGenerated,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: videoSize,
          total_chunk_count: 1,
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
    );

    const publishId = initRes.data?.data?.publish_id;
    const uploadUrl = initRes.data?.data?.upload_url;
    console.log('TIKTOK init:', JSON.stringify(initRes.data));

    if (!uploadUrl) {
      return res.status(500).json({ success: false, error: initRes.data });
    }

    await axios.put(uploadUrl, buffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoSize,
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    res.json({ success: true, publishId });
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

  const authUrl = `https://api.instagram.com/oauth/authorize?client_id=920676630923363&redirect_uri=https://focuspost-server-production.up.railway.app/auth/instagram/callback&scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments&response_type=code`;

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
const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload,video.publish&response_type=code&redirect_uri=https://focuspost-server-production.up.railway.app/auth/tiktok/callback&state=outpost`;
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
   console.log('TIKTOK TOKEN RESPONSE:', JSON.stringify(tokenRes.data));
    const { access_token, open_id } = tokenRes.data;
    res.redirect(`outpost://auth/tiktok?token=${access_token}&userId=${open_id}`); 
    
  } catch (error) {
    console.error('TikTok auth error:', error.response?.data || error.message);
    res.redirect('outpost://auth/tiktok?error=login_failed');
  }
});

// ─── STORY COMPOSITE (text + filter baked into 1080x1920) ───
const sharp = require('sharp');

app.post('/story/compose', async (req, res) => {
  try {
    const { imageUrl, text, textColor, fontFamily, fontWeight, filter, textXPercent, textYPercent, textScale } = req.body;

    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    // 1. Download the source image
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imgBuffer = Buffer.from(imgResp.data);

    // 2. Resize/fit to exactly 1080x1920 (story size), filling the frame
    let pipeline = sharp(imgBuffer).resize(1080, 1920, { fit: 'cover' });

    // 3. Apply filter as a color tint overlay
    const filterTints = {
      none: null,
      cool: { r: 59, g: 130, b: 246, alpha: 0.18 },
      warm: { r: 249, g: 115, b: 22, alpha: 0.18 },
      bw: null, // handled via grayscale below
      fade: { r: 255, g: 255, b: 255, alpha: 0.15 },
      sepia: { r: 160, g: 120, b: 60, alpha: 0.28 },
      noir: { r: 0, g: 0, b: 0, alpha: 0.32 },
      sunset: { r: 236, g: 72, b: 153, alpha: 0.2 },
      mint: { r: 34, g: 197, b: 94, alpha: 0.16 },
      dusk: { r: 99, g: 102, b: 241, alpha: 0.22 },
      peach: { r: 251, g: 146, b: 120, alpha: 0.22 },
      frost: { r: 147, g: 197, b: 253, alpha: 0.2 },
    };

    if (filter === 'bw') {
      pipeline = pipeline.grayscale();
    }

    let baseBuffer = await pipeline.png().toBuffer();

    const composites = [];

    // Filter tint layer
    const tint = filterTints[filter];
    if (tint) {
      const tintSvg = Buffer.from(
        `<svg width="1080" height="1920"><rect width="1080" height="1920" fill="rgba(${tint.r},${tint.g},${tint.b},${tint.alpha})"/></svg>`
      );
      composites.push({ input: tintSvg, top: 0, left: 0 });
    }

    // 4. Text layer (if text exists)
    if (text && text.trim()) {
      const fontSize = Math.round(64 * (textScale || 1));
      const yPos = Math.round((textYPercent || 45) / 100 * 1920);
      const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const textSvg = Buffer.from(`
        <svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
          <style>
            .txt { fill: ${textColor || '#ffffff'}; font-size: ${fontSize}px; font-family: ${fontFamily || 'sans-serif'}; font-weight: ${fontWeight || 700}; }
          </style>
          <text x="540" y="${yPos}" text-anchor="middle" class="txt">${escapedText}</text>
        </svg>
      `);
      composites.push({ input: textSvg, top: 0, left: 0 });
    }

    // 5. Composite everything
    const finalBuffer = await sharp(baseBuffer).composite(composites).jpeg({ quality: 95 }).toBuffer();

    // 6. Upload the finished image to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(
      `data:image/jpeg;base64,${finalBuffer.toString('base64')}`,
      { resource_type: 'image' }
    );

    res.json({ success: true, url: uploadResult.secure_url });
  } catch (error) {
    console.error('Story compose error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── AI: Improve Caption ───────────────────────────────
app.post('/ai/caption', async (req, res) => {
  try {
    const { caption } = req.body;
    if (!caption || !caption.trim()) {
      return res.status(400).json({ error: 'Caption is required' });
    }

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Rewrite this social media caption to be more engaging and punchy for Instagram. Keep it authentic and similar in length. Do not add hashtags. Return ONLY the improved caption with no quotes, no preamble, no explanation:\n\n${caption}`
      }]
    });

    const improved = msg.content[0].text.trim();
    res.json({ improved });
  } catch (error) {
    console.error('AI caption error:', error);
    res.status(500).json({ error: 'Could not improve caption' });
  }
});

// ─── AI: Suggest Hashtags ──────────────────────────────
app.post('/ai/hashtags', async (req, res) => {
  try {
    const { caption } = req.body;
    if (!caption || !caption.trim()) {
      return res.status(400).json({ error: 'Caption is required' });
    }

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Suggest 8 relevant, popular Instagram hashtags for this caption. Return ONLY a comma-separated list of hashtags (each starting with #), no other text:\n\n${caption}`
      }]
    });

    const raw = msg.content[0].text.trim();
    const hashtags = raw.split(',').map(h => h.trim()).filter(h => h.startsWith('#'));
    res.json({ hashtags });
  } catch (error) {
    console.error('AI hashtags error:', error);
    res.status(500).json({ error: 'Could not suggest hashtags' });
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

