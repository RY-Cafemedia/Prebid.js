import {
  ajaxBuilder
} from 'src/ajax';
import adapter from 'src/AnalyticsAdapter';
import CONSTANTS from 'src/constants.json';
import adaptermanager from 'src/adaptermanager';
import {
  generateUUID,
  uniques,
  flatten
} from 'src/utils';
import {
  auctionManager
} from 'src/auctionManager';

const analyticsType = 'endpoint';

let rockyouAnalytics = Object.assign(adapter({
  analyticsType
}), {
  lastAdUnitBidRequestIds: {},
  options: {},
  eventParameters: {},
  webRelayURL: 'https://collect.rockyou.com/v2'
});

// save the base class function
rockyouAnalytics.originEnableAnalytics = rockyouAnalytics.enableAnalytics;

// override enableAnalytics so we can get access to the config passed in from the page
rockyouAnalytics.enableAnalytics = function (config) {
  this.options = config.options || {};
  this.eventParameters = this.options.eventParameters || this.eventParameters;
  this.webRelayURL = this.options.webRelayURL || this.webRelayURL;

  // Register event listener with googletag
  googletag.cmd.push(function () {
    googletag.pubads().addEventListener('slotRenderEnded', function (event) {
      try {
        sendBidAnalytics(event);
      } catch (e) {
        log('Exception!', e);
      }
    });
  });
}

class BidEvent {
  constructor(cpm, bidder, adUnitCode, timeToRespond, isWinner, bidRequestId, isCached, creativeId, size, adId, requestTimeStamp) {
    isCached = isCached || false;

    this.bid_request_id          = bidRequestId;
    this.ad_unit                 = adUnitCode;
    this.bidder                  = bidder;
    this.cpm                     = cpm;
    this.response_time           = timeToRespond;
    this.url                     = window.location.href;
    this.winner                  = isWinner;
    this.cached                  = isCached;
    this.creative_id             = creativeId;
    this.size                    = size;
    this.ad_id                   = adId;
    this.bid_request_ts          = requestTimeStamp;

    // apply event parameters to this event
    for (let key in rockyouAnalytics.eventParameters) {
      this[key] = rockyouAnalytics.eventParameters[key];
    }
  }

  toURI() {
    var str = [];
    for (var p in this) {
      if (this.hasOwnProperty(p) && this[p] != null && this[p] !== '') {
        str.push(encodeURIComponent(p) + '=' + encodeURIComponent(this[p]));
      }
    }
    return str.join('&');
  }

  getURI() {
    return '/v2/bid?' + this.toURI();
  }
}

function sendBidAnalytics(event) {
  log('Invoking sendBidAnalytics', event);

  var adUnitCode = event.slot.getSlotElementId(),
    bidEvents            = [],
    largestBid           = 0.0,
    googleBid            = 0.0,
    auctionWinner        = getAuctionWinner(event),
    winnerFoundInAuction = false,
    isGoogleWinner       = false,
    bidRequestId,
    totalEarned,
    auction;

  auction = auctionManager.getLastAuction();

  if (auction !== undefined) {
    bidRequestId = auction.getBidRequestId(adUnitCode);
  }

  if (bidRequestId === undefined) {
    bidRequestId = generateUUID();
  }

  // dedupe bid events and skip adunits that do not use HB
  if (rockyouAnalytics.lastAdUnitBidRequestIds[adUnitCode] === bidRequestId) {
    return log('Duplicate bidRequestId detected for' + adUnitCode + '. Aborting');
  }

  rockyouAnalytics.lastAdUnitBidRequestIds[adUnitCode] = bidRequestId;

  if (auction) {
    // find bids for this ad unit, and send events for them
    auction.getBidsReceived().forEach(function (bid) {
      var isBidWinner = false,
        creativeId;

      if (bid.adUnitCode === adUnitCode) {
        if (bid.cpm > largestBid) {
          largestBid = bid.cpm;
        }

        // check to see if this bid is the winner
        if (auctionWinner.winner === 'prebid' &&
          bid.adId === auctionWinner.bidData.hb_adid[0]) {
          winnerFoundInAuction = true;

          if (event.isEmpty) {
            log('Winning bid found, but ad is empty', bid);
            isBidWinner = 'false'; // Spec calls for 'true' or 'false' strings
          } else {
            log('Winning bid found', bid);
            isBidWinner = 'true';
          }
        }

        creativeId = bid.creativeId || bid.adId;

        bidEvents.push(new BidEvent(bid.cpm, bid.bidder, adUnitCode, bid.timeToRespond, isBidWinner, bidRequestId, false, creativeId, bid.size, bid.adId, bid.requestTimestamp));
      }
    });

    // if we didn't find the winning bid in the previous auction but we know PBJS won, search cached bids as well.
    if (!winnerFoundInAuction && auctionWinner.winner === 'prebid') {
      log('Winning bid not found. checking cached bids')
      auctionManager.getBidsReceived().forEach(function (bid) {
        if (bid.adId === auctionWinner.bidData.hb_adid[0]) {
          log('Winning bid found amongst cached bids!', bid)
          var creativeId = bid.creativeId || bid.adId;

          bidEvents.push(new BidEvent(bid.cpm, bid.bidder, adUnitCode, bid.timeToRespond, true, bidRequestId, true, creativeId, bid.size, bid.adId, bid.requestTimestamp));
          return false; // break
        }
      });
    }
  } else {
    log('Auction not found!')
  }

  addMissingBids(bidEvents, adUnitCode, bidRequestId);

  // add $0.01 to cpm when google wins
  if (auctionWinner.winner === 'google') {
    log('Google Won')
    googleBid = largestBid += 0.01;
    isGoogleWinner = true;
  }

  // if no ad was shown, then we didn't make anything
  if (event.isEmpty) {
    log('Ad is empty')
    largestBid = 0.0;
    googleBid = 0.0;
  }

  // add a bid event for google too
  bidEvents.push(new BidEvent(googleBid, 'google', adUnitCode, 0, isGoogleWinner, bidRequestId, null, null, null, null, null));

  sendBidEvents(bidEvents);
}

function sendBidEvents(bidEvents) {

  log('Sending bid events', bidEvents);

  var ajax = ajaxBuilder(10000), // 10 second timeout
    requestData = {
      method: 'GET',
      requests: []
    };

  bidEvents.forEach(function (bidEvent) {
    requestData.requests.push({
      path: bidEvent.getURI()
    });
  });

  ajax(rockyouAnalytics.webRelayURL + '/batch', function() {}, JSON.stringify(requestData), {method: 'POST'});
}

// add bids for bidders that we asked for a bid but didn't receive one
function addMissingBids(bidEvents, adUnitCode, bidRequestId) {
  var bidders, respondingBidders, adUnit;

  adUnit = $$PREBID_GLOBAL$$.adUnits.find(_adUnit => _adUnit.code === adUnitCode);
  bidders = adUnit.bids.map(bid => bid.bidder).filter(uniques);

  if (bidders) {
    // compile list of bidders who we already have a bid from
    respondingBidders = bidEvents.map(bid => bid.bidder).filter(uniques);
    bidders = bidders.filter(bidder => !respondingBidders.includes(bidder)); // remove respondingBidders from bidders

    bidders.forEach(bidder => bidEvents.push(new BidEvent(0.0, bidder, adUnitCode, 0, false, bidRequestId, false, null, '', null, null)));
  }
}

function getAuctionWinner(event) {
  var auctionWinner = 'google',
    bidData = null;

  // size: [1,1] indicates a prebid win
  if (event.size[0] <= 1 && event.size[1] <= 1) {
    auctionWinner = 'prebid';
    bidData = event.slot.getTargetingMap();
  }

  return {
    winner: auctionWinner,
    bidData: bidData
  };
}

function log() {
  if ($$PREBID_GLOBAL$$.getConfig('debug')) {
    var args = [].slice.call(arguments);
    args.unshift('RY_ANALYTICS:')
    console.log.apply(console, args)
  }
}

adaptermanager.registerAnalyticsAdapter({
  adapter: rockyouAnalytics,
  code: 'rockyou'
});

// Array.find() pollyfill for IE
if (!Array.prototype.find) {
  Object.defineProperty(Array.prototype, 'find', {
    value: function(predicate) {
      var o = Object(this);
      var len = o.length >>> 0;
      var thisArg = arguments[1];
      var k = 0;

      while (k < len) {
        var kValue = o[k];
        if (predicate.call(thisArg, kValue, k, o)) {
          return kValue;
        }
        k++;
      }
      return undefined;
    },
    configurable: true,
    writable: true
  });
}

// array.includes polyfill
if (!Array.prototype.includes) {
  Object.defineProperty(Array.prototype, 'includes', {
    value: function(searchElement, fromIndex) {
      var o = Object(this);

      var len = o.length >>> 0;

      if (len === 0) {
        return false;
      }
      var n = fromIndex | 0;
      var k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);

      function sameValueZero(x, y) {
        return x === y || (typeof x === 'number' && typeof y === 'number' && isNaN(x) && isNaN(y));
      }

      while (k < len) {
        if (sameValueZero(o[k], searchElement)) {
          return true;
        }
        k++;
      }

      return false;
    }
  });
}