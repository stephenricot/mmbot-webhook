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

app.post('/api/public/whatsapp', (req, res) => {
  console.log('Incoming message:', JSON.stringify(req.body))
  res.sendStatus(200)
})

app.listen(process.env.PORT || 3000)
