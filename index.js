const express = require('express')
const app = express()
app.use(express.json())

app.get('/api/public/whatsapp', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

app.post('/api/public/whatsapp', async (req, res) => {
  res.sendStatus(200) // Respond to Meta immediately

  try {
    const entry = req.body?.entry?.[0]
    const changes = entry?.changes?.[0]
    const message = changes?.value?.messages?.[0]

    if (!message || message.type !== 'audio') return

    const audioId = message.audio.id
    const fromNumber = message.from

    console.log('Voice note received from:', fromNumber)
    console.log('Audio ID:', audioId)

    // Step 1 — Get audio URL from WhatsApp
    const mediaRes = await fetch(
    `https://graph.facebook.com/v18.0/${audioId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
    )
    const mediaData = await mediaRes.json()
    console.log('Media API response:', JSON.stringify(mediaData))
    const audioUrl = mediaData.url || mediaData?.messaging_product?.url
    if (!audioUrl) {
    console.error('No audio URL found in response:', mediaData)
    return
    }
    console.log('Audio URL retrieved:', audioUrl)

    // Step 2 — Download audio
    const audioRes = await fetch(audioUrl, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
    })
    const audioBuffer = await audioRes.arrayBuffer()
    console.log('Audio downloaded, size:', audioBuffer.byteLength)

    // Step 3 — Transcribe using OpenAI Whisper
    const FormData = require('form-data')
    const form = new FormData()
    form.append('file', Buffer.from(audioBuffer), {
      filename: 'audio.ogg',
      contentType: 'audio/ogg'
    })
    form.append('model', 'whisper-1')

    const transcribeRes = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders()
        },
        body: form
      }
    )
    const transcribeData = await transcribeRes.json()
    console.log('Whisper API response:', JSON.stringify(transcribeData))
    const transcript = transcribeData.text

    if (!transcript) {
    console.error('Transcription failed:', JSON.stringify(transcribeData))
    return
    }
    console.log('Transcript:', transcript)

    // Step 4 — Extract meeting minutes using OpenAI
    const minutesRes = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [{
            role: 'system',
            content: `You are a meeting minutes extractor. 
            From the transcript, extract and format:
            - Meeting Topic
            - Attendees (if mentioned)
            - Key Points discussed
            - Decisions made
            - Action Items (with person responsible and due date if mentioned)
            - Next meeting (if mentioned)
            Format the response as a clean WhatsApp message using emojis.`
          }, {
            role: 'user',
            content: `Extract meeting minutes from this transcript: ${transcript}`
          }]
        })
      }
    )
    const minutesData = await minutesRes.json()
    const minutes = minutesData.choices[0].message.content
    console.log('Minutes extracted')

    // Step 5 — Send reply back to WhatsApp
    await fetch(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: fromNumber,
          type: 'text',
          text: { body: `📋 *Meeting Minutes*\n\n${minutes}` }
        })
      }
    )
    console.log('Reply sent to:', fromNumber)

    // Step 6 — Save to Supabase
    const { createClient } = require('@supabase/supabase-js')
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    )
    await supabase.from('meetings').insert({
      from_number: fromNumber,
      transcript: transcript,
      summary: minutes,
      created_at: new Date().toISOString()
    })
    console.log('Saved to Supabase')

  } catch (error) {
    console.error('Processing error:', error)
  }
})

app.listen(process.env.PORT || 3000, () => {
  console.log('Webhook server running')
})
