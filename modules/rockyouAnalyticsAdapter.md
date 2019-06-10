# Rockyou Analytics Adapter

## Requirements

This adapter assumes that google GPT is being used with pbjs and is available globally via the `googletag` object.

Also expects a modified prebid.js with `getLastAuction()` method added to `auctionManager.js`:

```javascript
  auctionManager.getLastAuction = function() {
    if(_auctions.length == 0) {
      return undefined;
    }
    
    return _auctions[_auctions.length-1];
  }
```


## Usage

To enable the adapter, use the `pbjs.enableAnalytics()` function with `rockyou` as the provider.

The `rockyou` provider expects an `eventParameters` object passed in `options`. This object must contain at least an `app` parameter, specifying which app this is. Any other parameters added here will be added to every bid event. Parameters set here will override parameters set automatically by the adapter. 

### Example

```javascript
pbjs.enableAnalytics({
  provider: 'rockyou',
  options: {
    webRelayURL: "https://qa-collect.rockyou.com/v2",
    eventParameters: {
      app:     'fanbread',
      user_id: app.Heartbeat.getUserId(),
      post_id: 'post' in gon ? gon.post.id: null,
      site_id: gon.currentSite.id,
      ua_id:   app.Heartbeat.getUaId()
    }
  }
});
```