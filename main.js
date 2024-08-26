console.log("Hi world");

const express = require('express')
const app = express()
const port = 3000

app.get('/', (req, res) => {
  //res.send('Hello World!')

  // https://nodejs.org/api/http.html#httpgeturl-options-callback
  const url = 'http://192.168.107.9/live/stream0';
  request.get(url).pipe(res);
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
