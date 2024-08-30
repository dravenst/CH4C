console.log("Hello World");

const channelsUrl = 'http://192.168.0.41:8089/dvr/jobs/new'
const data = {
    "Name": "JF test record",
    "Time": 1601391600,
    "Duration": 120, // unit?
    "Channels": ["22.1"],
    "Airing": {
        "SeasonNumber": 0,
        "EpisodeNumber": 0,
        "OriginalDate": "2020-09-29",
    }
};
const jsonData = JSON.stringify(data)
console.log(jsonData);

// https://oxylabs.io/blog/nodejs-fetch-api
// this fails because Mealie can't initiate to Channels
fetch(channelsUrl, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json',
    },
    body: jsonData,
  })
    .then((response) => response.json())
    .then((json) => console.log(json))
    .catch((error) => {
        console.error('error in execution', error);
    }); 


/*
{
    "Name": "Manual Recordings",
    "Time": 1601391600,
    "Duration": 120,
    "Channels": ["6750"],
    "Airing": {
        "Source": "manual",
        "Channel": "6750",
        "OriginalDate": "2020-09-29",
        "Time": 1601391600,
        "Duration": 120,
        "Title": "Manual Recordings",
        "EpisodeTitle": "BUZZR Test Recording",
        "Summary": "Record BUZZR-6750 on Tuesday, September 29, 2020 3:00:00 PM GMT for 2 minutes.",
        "Image": "https://tmsimg.fancybits.co/assets/p9467679_st_h6_aa.jpg",
        "ProgramID": "SH030703030000",
        "SeasonNumber": 0,
        "EpisodeNumber": 0,
        "Raw": ""
    }
}
*/