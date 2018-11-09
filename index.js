require('dotenv').config();
const fs = require('fs');
const _ = require('lodash');
const axios = require('axios');
const request = require('request');
const winston = require('winston');

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

const loadBalancerID = 'db39795b-b4d8-4f4d-8722-509b89f4eae1';
const loadBalanceThreshold = 100;
const minimumDroplets = 2;

let init = false;
let draining = false;
let initializing = false;
let initialized = true;
let clearInitialization = false;
let availableDroplets = [];
let totalListeners = 0;
let serverPromises = [];

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
        request(`http://${ ip }:1337/status-json.xsl`, { json: true }, (err, response, body) => {
          if (body) {
            initialized = true;
            initializing = droplet.id;
            clearInitialization = setTimeout(() => {
              initializing = false;
            }, 60000 * 5);
            updateLoadBalancers();
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
    }
  }, 60000 * 2)
}

function createDroplet() {
  api
  .post('v2/droplets',
    { 
      name: 'icecast-slave',
      region: 'nyc1',
      size: 's-1vcpu-1gb',
      image: '38819457',
      ssh_keys: ['20298220', '20398405'],
      backups: 'false',
      ipv6: false,
      user_data: '/etc/init.d/icecast2 start',
      private_networking: null,
      volumes: null,
      monitoring: false,
      volumes: null,
      tags: ['icecast']
    }
  )
  .then((res) => checkNewDroplet(res.data.droplet))
  .catch((err) => {});
}

function deleteDroplet(droplet) {
  api.delete(`v2/droplets/${ droplet }`)
  .then((res) => { console.log('DROPLET DELETED', droplet ); updateLoadBalancers(); })
  .catch(err => {});
}

function updateLoadBalancers(remove) {
  const dropletIDs = []
  availableDroplets.forEach((droplet) => {
    dropletIDs.push(droplet.id);
  });

  if (remove) {
    draining = dropletIDs[dropletIDs.length - 1].id;
    dropletIDs.pop();
  }
  
  console.log('DROPLET IDS', dropletIDs);

  api.put(`v2/load_balancers/${ loadBalancerID }`, {
    name: 'icecast-load-balancer',
    region: 'nyc1',
    algorithm: 'least_connections',
    forwarding_rules: [
      {
        entry_protocol: 'http',
        entry_port: 80,
        target_protocol: 'http',
        target_port: 1337
      }
    ],
    health_check: {
      protocol: 'tcp',
      port: 1337,
      check_interval_seconds: 10,
      response_timeout_seconds: 5,
      healthy_threshold: 5,
      unhealthy_threshold: 3
    },
    sticky_sessions: {},
    droplet_ids: dropletIDs
  }).then(res => { console.log('UPDATED LOAD BALANCER') })
  .catch(err => {});
}

// api.get('v2/load_balancers', (res) => console.log(res));
logger.info(`INITIALIZING SCALER WITH, ${ minimumDroplets } MINIMUM DROPLETS`);

// Load monitor
setInterval(() => {
    api.get('v2/droplets?tag_name=icecast')
    .then(res => {
      totalListeners = 0;

      if (res.data) {
        availableDroplets = res.data.droplets;

        // Run check one at a time, and while not initializing new droplet
        if (serverPromises.length === 0 && initialized) {
          if (!init) {
            updateLoadBalancers();
            init = true;
          }

          // Gather listening stats across all droplets
          for (let i = 0; i < availableDroplets.length; i++) {
            // console.log('available loop', availableDroplets[i].networks.v4);
            if (availableDroplets[i].networks.v4[0]) {
              const ip = availableDroplets[i].networks.v4[0].ip_address;
              serverPromises.push(
                new Promise((resolve, reject) => {
                  request(`http://${ ip }:1337/status-json.xsl`, { json: true }, (err, response, body) => {
                    if (body) {
                      body.droplet = availableDroplets[i].id;
                      console.log('AVAILABLE', i, availableDroplets[i].id);
                      resolve(body);
                    } else {
                      reject(err);
                    }
                  });
                }).catch(err => {})
              );
            }
          }

          // Count total / average listeners across all droplets
          Promise.all(serverPromises).then((values) => {
            // Check to ensure not to kill newly created droplet
            const isInitialized = _.find(values, droplet => droplet.droplet === initializing);
            let deleting = false;
            if (values) {
              for (let i = 0; i < values.length; i++) {
                if (values[i] && values[i].icestats) {
                  if (values[i].icestats.source) {
                    let sources = values[i].icestats.source;
                    if (!Array.isArray(values[i].icestats.source)) {
                      sources = [sources];
                    }

                    let dropletListeners = 0;
                    for (let j = 0; j < sources.length; j++) {
                      dropletListeners += sources[j].listeners;
                      totalListeners += sources[j].listeners;
                    }

                    console.log('droplet listeners', values[i].droplet, dropletListeners);
                    if (dropletListeners === 0 && values.length > minimumDroplets && !isInitialized && !deleting) {
                      logger.info(`DELETING, ${ dropletListeners }, ${ values.length }, ${ minimumDroplets }, ${ isInitialized }`);
                      deleteDroplet(values[i].droplet);
                      deleting = true;
                    }
                  }
                }
              }
            }

            const averageListeners = totalListeners / values.length;
            const addInitializing = initializing ? 1 : 0
            if ((!isNaN(averageListeners) && averageListeners > loadBalanceThreshold) || (availableDroplets.length) < minimumDroplets) {
              logger.info(`CREATING, ${ averageListeners }, ${ loadBalanceThreshold }, ${ availableDroplets.length }, ${ minimumDroplets }`);
              if (draining) {
                draining = false;
                updateLoadBalancers();
              } else {
                createDroplet();
                console.log('CREATING NEW DROPLET, AVERAGE WAS: ', averageListeners, values.length);
              }
            } else if (((totalListeners < 100) || totalListeners < ((availableDroplets.length * loadBalanceThreshold) - 200)) && availableDroplets.length > minimumDroplets) {
              // Drain droplet
              updateLoadBalancers(true);
              console.log('UPDATING LOAD BALANCER, AVERAGE WAS: ', averageListeners, values.length);
            }

            serverPromises = [];
          })
        }
      }
    })
    .catch(err => { console.log('GOT ERROR', err); });
}, 10000);
