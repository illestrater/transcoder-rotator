require('dotenv').config();
const fs = require('fs');
const _ = require('lodash');
const axios = require('axios');
const request = require('request');
const winston = require('winston');
const express = require('express');
const http = require('http');
const cors = require('cors');
const bodyParser = require('body-parser');

const ENV = process.env;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

logger.add(new winston.transports.Console({
  format: winston.format.simple()
}));

const api = axios.create({
  baseURL: 'https://api.digitalocean.com/',
  responseType: 'json',
  crossDomain: true
});

axios.defaults.headers.common.Authorization = fs.readFileSync(ENV.DIGITALOCEAN_KEY, 'utf8').trim();

const minimumDroplets = 1;

const TIME_TIL_RESET = 60000 * 60 * 3;
const HEALTH_MEM_THRESHOLD = 4;

let init = false;
let initializing = false;
let initialized = true;
let clearInitialization = false;
let availableDroplets = [];
let serverPromises = [];
let flushing = [];
let currentTranscoder = null;

function checkNewDroplet(droplet) {
  initializing = false;
  initialized = false;
  if (clearInitialization) {
    clearInterval(clearInitialization);
    clearInitialization = false;
  }

  const initializationChecker = setInterval(() => {
    const found = _.find(availableDroplets, (drop) => drop.id === droplet.id);
    if (found) {
      if (found.networks.v4.length > 0) {
        const ip = found.networks.v4[0].ip_address;
        console.log('GOT DROPLET IP', ip);
        request(`http://${ ip }:8080/health`, { json: true }, (err, response, body) => {
          if (body) {
            initialized = true;
            initializing = droplet.id;
            clearInitialization = setTimeout(() => {
              initializing = false;
            }, 60000 * 5);
            console.log('CLEARING CHECKER');
            clearInterval(initializationChecker);
          }
        });
      }
    }
  }, 5000);

  setTimeout(() => {
    if (!initializing && availableDroplets.length > minimumDroplets) {
      api.delete(`v2/droplets/${ droplet.id }`)
      .then((res) => console.log(`DESTROYED DEAD DROPLET ${ droplet.id }`))
      clearInterval(initializationChecker);
      initialized = true;
    }
  }, 60000 * 5)
}

function createDroplet() {
  console.log('CREATING DROPLET');
  api.post('v2/droplets',
    { 
      name: 'transcoder',
      region: 'nyc1',
      size: 's-1vcpu-1gb',
      image: '42212259',
      ssh_keys: ['20298220', '20398405'],
      backups: 'false',
      ipv6: false,
      user_data: '#cloud-config\nruncmd:\n - /opt/transcoder-controls/liquidsoap /opt/transcoder-controls/transcoder.liq\n - /root/.nvm/versions/node/v8.12.0/bin/node /opt/transcoder-controls/index.js',
      private_networking: null,
      monitoring: false,
      volumes: null,
      tags: ['liquidsoap']
    }
  )
  .then((res) => { console.log('CREATED!', res.data.droplet); checkNewDroplet(res.data.droplet); })
  .catch((err) => { console.log('ERROR CREATING DROPLET', err); });
}

function deleteDroplet(droplet) {
  api.delete(`v2/droplets/${ droplet }`)
  .then((res) => { console.log('DROPLET DELETED', droplet ); })
  .catch(err => {});
}

// api.get('v2/load_balancers', (res) => console.log(res));
logger.info(`INITIALIZING TRANSCODER ROTATOR WITH, ${ minimumDroplets } MINIMUM DROPLETS`);

// Load monitor
setInterval(() => {
    api.get('v2/droplets?tag_name=liquidsoap')
    .then(res => {
      if (res.data) {
        availableDroplets = res.data.droplets;

        // Run check one at a time, and while not initializing new droplet
        if (serverPromises.length === 0 && initialized) {
          // Gather health of all droplets
          for (let i = 0; i < availableDroplets.length; i++) {
            // console.log('available loop', availableDroplets[i].networks.v4);
            if (availableDroplets[i].networks.v4[0]) {
              const ip = availableDroplets[i].networks.v4[0].ip_address;
              serverPromises.push(
                new Promise((resolve, reject) => {
                  request(`http://${ ip }:8080/health`, { json: true }, (err, response, body) => {
                    if (body) {
                      body.droplet = availableDroplets[i].id;
                      body.ip = ip;
                      resolve(body);
                    } else {
                      reject(err);
                    }
                  });
                }).catch(err => {})
              );
            }
          }

          Promise.all(serverPromises).then((values) => {
            let deleting = false;
            if (values) {
              const unhealthy = [];
              const healthy = [];
              for (let i = 0; i < values.length; i++) {
                if (values[i] && values[i].usage) {
                  if (values[i].usage >= HEALTH_MEM_THRESHOLD) {
                    unhealthy.push(values[i]);
                  } else if (values[i].usage < HEALTH_MEM_THRESHOLD) {
                    healthy.push(values[i]);
                  }
                }
              }

              // Initialize first transcoder
              if (!init) {
                currentTranscoder = values[0];
                init = true;
              }  

              // Check to ensure not to kill newly created droplet
              // const isInitialized = _.find(values, droplet => initializing === droplet.droplet);

              // Push new unhealthy droplets to flushing state
              for (let i = 0; i < unhealthy.length; i++) {
                const exists = _.find(flushing, droplet => unhealthy[i].droplet === droplet.droplet);
                if (!exists) {
                  console.log('ATTEMPTING FLUSH');
                  flushing.push(unhealthy[i]);
                  request({
                    url: `http://${ unhealthy[i].ip }:8080/stop_liquidsoap`,
                    method: 'POST',
                    json: {
                        ttr: TIME_TIL_RESET
                    }
                  }, (err, response, body) => {
                    if (body && body.success) {
                      console.log('FLUSHING!', unhealthy[i].droplet);
                      setTimeout(() => {
                        request(`http://${ unhealthy[i].ip }:8080/start_liquidsoap`, { json: true }, (err, response, body) => {
                          const compare = unhealthy[i].droplet;
                          flushing = _.remove(flushing, droplet => compare === droplet.droplet);
                          console.log('TRANSCODER RESTORED!', unhealthy[i].droplet);
                        });
                      }, TIME_TIL_RESET + 5000);
                    }
                  });
                }
              }

              console.log('HEALTHY', healthy);
              console.log('UNHEALTHY', unhealthy);
              console.log('FLUSHING', flushing);

              // If current transcoder becomes unhealthy, select new transcoding droplet
              const currentIsUnhealthy = _.find(unhealthy, droplet => droplet.droplet === currentTranscoder.droplet);
              if (currentIsUnhealthy) {
                let newCurrent;
                for (let i = 0; i < healthy.length; i++) {
                  const exists = _.find(flushing, droplet => droplet.droplet === healthy[i].droplet);
                  console.log('EXISTS', exists);
                  if (!exists) {
                    newCurrent = healthy[i];
                  }
                }

                console.log('CHECKING STATE', newCurrent, initializing);
                if (newCurrent) {
                  currentTranscoder = newCurrent;
                } else if (!initializing) {
                  // If all are unhealthy, spin up new transcoder droplet
                  initializing = true;
                  createDroplet();
                }
              }

              console.log('CURRENT TRANSCODER :', currentTranscoder);
            }

            serverPromises = [];
          })
        }
      }
    })
    .catch(err => { console.log('GOT ERROR', err); });
}, 10000);


const app = express();
app.use(cors());
app.use(bodyParser.json());

app.get('/current', (req, res) => {
  res.json(currentTranscoder);
});

// const activeEndpoints = [];
// app.post('/start', (req, res) => {
//   const stream = {
//     droplet: currentTranscoder.droplet.slice(),
//     ip: currentTranscoder.ip.slice(),
//     public: req.body.public,
//     private: req.body.private
//   };

//   activeEndpoints.push(stream)

//   request({
//     url: `http://${ currentTranscoder.ip }:8080/start`,
//     method: 'POST',
//     json: { stream }
//   }, (err, response, body) => {
//     if (body) {
//       console.log(`STARTING ON ${ currentTranscoder.droplet }`, body);
//       return res.json(body);
//     } else {
//       return res.status(409).json({ error: 'Could not start stream' });
//     }
//   });
// });

// app.post('/stop', (req, res) => {
//   const index = activeEndpoints.map((x) => x.public).indexOf(req.body.public);
//   const found = activeEndpoints[index];
//   if (found !== -1) {
//     activeEndpoints.splice(index, 1);

//     request({
//       url: `http://${ found.ip }:8080/stop`,
//       method: 'POST',
//       json: { public: req.body.public, private: req.body.private }
//     }, (err, response, body) => {
//       if (body) {
//         console.log(`TRANSCODER ${ public } STOPPED`, body);
//         return res.json(body);
//       } else {
//         return res.status(409).json({ error: 'Could not stop stream' });
//       }
//     });
//   } else {
//     return res.status(409).json({ error: 'Could not find stream' });
//   }
// })

const server = http.createServer(app);
server.listen(2222);
