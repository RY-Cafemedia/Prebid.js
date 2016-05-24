var bidfactory = require('../bidfactory.js');
var bidmanager = require('../bidmanager.js');
var adloader = require('../adloader');
var utils = require('../utils.js');

var OpenxAdapter = function OpenxAdapter(options) {
  const BIDDER_CODE = 'openx_neo';
  let ieVersion = (function () {
    let rv = 0, ua, re;
    if (navigator) {
      try {
        ua = navigator.userAgent;
        if (navigator.appName === "Microsoft Internet Explorer") {
          re = new RegExp("MSIE ([0-9]{1,}[\\.0-9]{0,})");
          if (re.exec(ua) !== null) {
            rv = parseFloat(RegExp.$1);
          }
        } else if (navigator.appName === "Netscape") {
          re = new RegExp("Trident/.*rv:([0-9]{1,}[\\.0-9]{0,})");
          if (re.exec(ua) !== null) {
            rv = parseFloat(RegExp.$1);
          }
        }
      } catch (e) { }
      return rv;
    }
  })();
  let createNewFrameElement = function (name, width, height) {
    let frame;

    try {
      frame = (ieVersion && name) ?
        document.createElement('<iframe name="' + name + '">')
        : document.createElement("iframe");
    } catch (e) {
      frame = document.createElement("iframe");
    }

    frame.setAttribute("width", width);
    frame.setAttribute("height", height);
    frame.setAttribute("frameSpacing", "0");
    frame.setAttribute("frameBorder", "no");
    frame.setAttribute("scrolling", "no");

    if (name) {
      frame.setAttribute("id", name);
      frame.setAttribute("name", name);
    }

    return frame;
  };
  let pdNode = null;
  let objectKeys = function (obj) {
    if (Object.keys) {
      return Object.keys.apply(this, arguments);
    } else {
      let keys = [];
      for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
          keys.push(key);
        }
      }
      return keys;
    }
  };

  return {
    callBids: callBids
  };

  function setGlobalOptionsFromBids(bids) {
    var opts = options || {};
    for (let bid of bids) {
      if (bid.params.delDomain) {
        opts.delDomain = bid.params.delDomain;
      }
    }
    return opts;
  }

  function getTWS(isIfr) {
    var width,
      height,
      tWin = window,
      tDoc = document,
      docEl = tDoc.documentElement,
      body;

    if (isIfr) {
      tWin = window.top;
      tDoc = window.top.document;
      docEl = tDoc.documentElement;
      body = tDoc.body;

      width = tWin.innerWidth || docEl.clientWidth || body.clientWidth;
      height = tWin.innerHeight || docEl.clientHeight || body.clientHeight;
    } else {
      docEl = tDoc.documentElement;
      width = tWin.innerWidth || docEl.clientWidth;
      height = tWin.innerHeight || docEl.clientHeight;
    }

    return `${width}x${height}`;
  }

  function makePDCall(pixelsUrl) {
    let pdFrame = createNewFrameElement(name, 0, 0);
    let rootNode = document.body;

    if (!rootNode) {
      return;
    }

    pdFrame.src = pixelsUrl;

    if (pdNode) {
      pdNode.parentNode.replaceChild(pdFrame, pdNode);
      pdNode = pdFrame;
    } else {
      pdNode = rootNode.appendChild(pdFrame);
    }
  }

  function addBidResponse(adUnit, bid) {
    var bidResponse = bidfactory.createBid(adUnit ? 1 : 2);
    bidResponse.bidderCode = BIDDER_CODE;

    if (adUnit) {
      let creative = adUnit.creative[0];
      bidResponse.ad = adUnit.html;
      bidResponse.cpm = Number(adUnit.pub_rev) / 1000;
      bidResponse.ad_id = adUnit.adid;
      if (creative) {
        bidResponse.width = creative.width;
        bidResponse.height = creative.height;
      }
    }

    bidmanager.addBidResponse(bid.placementCode, bidResponse);
  }

  function buildQueryStringFromParams(params) {
    for (var key in params) {
      if (params.hasOwnProperty(key)) {
        if (!params[key]) {
          delete params[key];
        }
      }
    }
    return utils._map(objectKeys(params), key => `${key}=${params[key]}`)
      .join('&');
  }

  function buildRequest(bids, params, reqOpts) {
    let rqRand = Math.floor(Math.random() * 9999999999);
    if (!utils.isArray(bids)) {
      return;
    }
    
    params.auid = utils._map(bids, bid => bid.params.unit).join('%2C');
    params.aus = utils._map(bids, bid => {
      if (utils.isArray(bid.sizes)) {
        return utils._map(bid.sizes, sizeSet => {
          if (utils.isArray(sizeSet)) {
            return `${sizeSet[0]}x${sizeSet[1]}`;  
          }
          return String(sizeSet);
        }).join(','); 
      }
      return String(bid.sizes);
    }).join('|');
    
    params.callback = `oxc${rqRand}`;
    let queryString = buildQueryStringFromParams(params);

    window[params.callback] = res => {
      let adUnits = res.ads.ad;
      if (res.ads && res.ads.pixels) { 
        makePDCall(res.ads.pixels); 
      }

      if (!adUnits) {
        return;
      }

      for (let bid of bids) {
        let auid = null;
        let adUnit = null;
        // find the adunit in the response
        for (adUnit of adUnits) {
          if (bid.params.unit === String(adUnit.adunitid) && !adUnit.used) {
            auid = adUnit.adunitid;
            break;
          }
        }

        if (!auid) {
          // didnt find it, drat
          continue;
        }
        adUnit.used = true;

        if (adUnit.pub_rev) {
          addBidResponse(adUnit, bid, reqOpts);
        } else { // no fill :(
          addBidResponse(null, bid, reqOpts);
        }

      }
    };

    adloader.loadScript(`//${reqOpts.delDomain}/w/1.0/arj?${queryString}`);
  }

  function callBids(params) {
    let startTime = new Date(),
      isIfr = window.self !== window.top,
      bids = params.bids,
      opts = setGlobalOptionsFromBids(params.bids),
      currentURL = window.location.href && encodeURIComponent(window.location.href);

    opts.startTime = startTime;

    buildRequest(bids, {
      ju: currentURL,
      jr: currentURL,
      ch: document.charSet || document.characterSet,
      res: `${screen.width}x${screen.height}x${screen.colorDepth}`,
      ifr: isIfr,
      tz: startTime.getTimezoneOffset(),
      tws: getTWS(isIfr),
      cc: 1,
      ee: 'api_sync_write',
      ef: 'bt%2Cdb',
      be: 1
    },
      opts);
  }
};

module.exports = OpenxAdapter;