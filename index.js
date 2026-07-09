const express = require('express')
const FormData = require('form-data')
const fetch = require('node-fetch')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(express.json())

// Helper function to send WhatsApp messages
async function sendWhatsAppMessage(to, message) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to,
          type: 'text',
          text: { body: message }
        })
      }
    )
    const data = await res.json()
    console.log('WhatsApp send response:', JSON.stringify(data))
    return data
  } catch (error) {
    console.error('WhatsApp send error:', error)
  }
}

// GET — Meta webhook verification
app.get('/api/public/whatsapp', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified successfully')
    res.status(200).send(challenge)
  } else {
    console.log('Webhook verification failed')
    res.sendStatus(403)
  }
})

// POST — Incoming WhatsApp messages
app.post('/api/public/whatsapp', async (req, res) => {
  res.sendStatus(200) // Respond to Meta immediately

  try {
    const entry = req.body?.entry?.[0]
    const changes = entry?.changes?.[0]
    const message = changes?.value?.messages?.[0]
    const fromNumber = changes?.value?.contacts?.[0]?.wa_id || message?.from

    // Skip if not a voice message
    if (!message || message.type !== 'audio') {
      console.log('Not a voice message, skipping')
      return
    }

    const audioId = message.audio.id
    console.log('Voice note received from:', fromNumber)
    console.log('Audio ID:', audioId)

    // Step 1 — Get audio URL from WhatsApp
    const mediaRes = await fetch(
      `https://graph.facebook.com/v18.0/${audioId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
        }
      }
    )
    const mediaData = await mediaRes.json()
    console.log('Media API response:', JSON.stringify(mediaData))

    const audioUrl = mediaData.url
    if (!audioUrl) {
      console.error('No audio URL found:', JSON.stringify(mediaData))
      await sendWhatsAppMessage(
        fromNumber,
        'Sorry, I could not access your voice note. Please try again.'
      )
      return
    }
    console.log('Audio URL retrieved successfully')

    // Step 2 — Download audio from WhatsApp
    const audioRes = await fetch(audioUrl, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
      }
    })
    const audioArrayBuffer = await audioRes.arrayBuffer()
    const audioBuffer = Buffer.from(audioArrayBuffer)
    console.log('Audio downloaded, size:', audioBuffer.length)

    if (audioBuffer.length === 0) {
      console.error('Audio buffer is empty')
      await sendWhatsAppMessage(
        fromNumber,
        'Sorry, the voice note appears to be empty. Please try again.'
      )
      return
    }

    // Step 3 — Transcribe using Groq Whisper (free)
    console.log('Sending to Groq for transcription...')
    const form = new FormData()
    form.append('file', audioBuffer, {
      filename: 'audio.ogg',
      contentType: 'audio/ogg; codecs=opus',
      knownLength: audioBuffer.length
    })
    form.append('model', 'whisper-large-v3')
    form.append('language', 'en')
    form.append('response_format', 'json')

    const transcribeRes = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          ...form.getHeaders()
        },
        body: form
      }
    )
    const transcribeData = await transcribeRes.json()
    console.log('Groq transcription response:', JSON.stringify(transcribeData))

    const transcript = transcribeData.text
    if (!transcript) {
      console.error('Transcription failed:', JSON.stringify(transcribeData))
      await sendWhatsAppMessage(
        fromNumber,
        'Sorry, I could not transcribe your voice note. Please speak clearly and try again.'
      )
      return
    }
    console.log('Transcript:', transcript)

    // Step 4 — Extract meeting minutes using Groq LLaMA (free)
    console.log('Extracting meeting minutes...')
    const minutesRes = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [
            {
              role: 'system',
              content: `You are a professional meeting minutes extractor.
              From the transcript provided, extract and format:
              
              📌 *Meeting Topic*
              👥 *Attendees* (if mentioned)
              📝 *Key Points Discussed*
              ✅ *Decisions Made*
              📋 *Action Items* (with person responsible and due date if mentioned)
              📅 *Next Meeting* (if mentioned)
              
              Format as a clean WhatsApp message using emojis.
              Be concise and professional.
              Skip sections not mentioned in the transcript.`
            },
            {
              role: 'user',
              content: `Extract meeting minutes from this transcript:\n\n${transcript}`
            }
          ],
          temperature: 0.3,
          max_tokens: 1024
        })
      }
    )
    const minutesData = await minutesRes.json()
    console.log('Groq minutes response:', JSON.stringify(minutesData))

    const minutes = minutesData.choices?.[0]?.message?.content
    if (!minutes) {
      console.error('Minutes extraction failed:', JSON.stringify(minutesData))
      await sendWhatsAppMessage(
        fromNumber,
        'Sorry, I could not extract meeting minutes. Please try again.'
      )
      return
    }
    console.log('Minutes extracted successfully')

    // Step 5 — Send reply back to WhatsApp
    await sendWhatsAppMessage(
      fromNumber,
      `📋 *Meeting Minutes*\n\n${minutes}`
    )
    console.log('Reply sent to:', fromNumber)

    // Step 6 — Save to Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    )
    const { error } = await supabase.from('meetings').insert({
      from_number: fromNumber,
      transcript: transcript,
      summary: minutes,
      created_at: new Date().toISOString()
    })

    if (error) {
      console.error('Supabase save error:', error)
    } else {
      console.log('Saved to Supabase successfully')
    }

  } catch (error) {
    console.error('Processing error:', error)
  }
})

app.listen(process.env.PORT || 3000, () => {
  console.log('Webhook server running')
})
