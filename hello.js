console.log("Hello World");

// building and sending the JSON object
const channelsUrl = 'http://192.168.0.41:8089/dvr/jobs/new'
// https://www.epochconverter.com/
const data = {
    "Name": "JF test record",
    "Time": 1726119609,   // 9/12/2024
    "Duration": 300, // seconds
    "Channels": ["24.42"],
    "Airing": {
        "Source": "manual",
        "Channel": "24.42",
        "Time": 1726119609,   // ok to be in the past
        "Duration": 300,
        "Title": "Manual recording JF test",
    }
};

const jsonData = JSON.stringify(data)
console.log(jsonData);

// https://oxylabs.io/blog/nodejs-fetch-api
fetch(channelsUrl, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json',
    },
    body: jsonData,
  })
    .then(response => {
        if (response.ok) {
            return response.json()
        }else{
            throw response.status
        }
    })
    .then(result => {
        console.log(result)
        console.log('done it')
    })
    .catch((error) => {
        console.error('Unable to schedule recording', error);
    });