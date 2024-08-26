// console.log("Hi world");

const express = require('express')
const { Readable } = require( "stream" )

const app = express()
const port = 3000

app.get('/', async (req, res) => {
  // res.send('Hello World!')

  // get the encoder stream
  const myUrl = 'http://192.168.107.9/live/stream0'
  const fetchResponse = await fetch(myUrl)

  // send the pipe of the stream to the request
  Readable.fromWeb(fetchResponse.body).pipe(res)
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

