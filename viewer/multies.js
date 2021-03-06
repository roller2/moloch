/******************************************************************************/
/* multies.js  -- Make multiple ES servers look like one but merging results
 *
 * Copyright 2012-2014 AOL Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this Software except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/*jshint
  node: true, plusplus: false, curly: true, eqeqeq: true, immed: true, latedef: true, newcap: true, nonew: true, undef: true, strict: true, trailing: true
*/
"use strict";


//// Modules
//////////////////////////////////////////////////////////////////////////////////
try {
var Config         = require('./config.js'),
    express        = require('express'),
    async          = require('async'),
    sprintf        = require('./public/sprintf.js'),
    os             = require('os'),
    util           = require('util'),
    URL            = require('url'),
    ESC            = require('elasticsearch'),
    http           = require('http'),
    KAA            = require('keep-alive-agent');
} catch (e) {
  console.log ("ERROR - Couldn't load some dependancies, maybe need to 'npm update' inside viewer directory", e);
  process.exit(1);
}

var clients = {};
var nodes;
var agent = new KAA({maxSockets: 100});

function hasBody(req) {
  var encoding = 'transfer-encoding' in req.headers;
  var length = 'content-length' in req.headers && req.headers['content-length'] !== '0';
  return encoding || length;
}

function saveBody (req, res, next) {
  if (req._body) {return next();}
  req.body = req.body || {};

  if (!hasBody(req)) {return next();}

  // flag as parsed
  req._body = true;

  // parse
  var buf = '';
  req.setEncoding('utf8');
  req.on('data', function(chunk){ buf += chunk; });
  req.on('end', function(){
    req.body = buf;
    next();
  });
}

var app = express();
app.configure(function() {
  app.enable("jsonp callback");
  app.use(express.favicon(__dirname + '/public/favicon.ico'));
  app.use(express.logger({ format: ':date \x1b[1m:method\x1b[0m \x1b[33m:url\x1b[0m :res[content-length] bytes :response-time ms' }));
  app.use(saveBody);
  app.use(express.compress());
  app.use(function(req, res, next) {
    if (res.setTimeout) {
      res.setTimeout(10 * 60 * 1000); // Increase default from 2 min to 10 min
      return next();
    }
  });
});

function simpleGather(req, res, bodies, doneCb) {
  console.log(req.method, req.url);

  async.map(nodes, function (node, asyncCb) {
    var result = "";
    var url = "http://" + node + req.url;
    var info = URL.parse(url);
    info.method = req.method;
    info.agent  = agent;
    var preq = http.request(info, function(pres) {
      pres.on('data', function (chunk) {
        result += chunk.toString();
      });
      pres.on('end', function () {
        if (result.length) {
          result = JSON.parse(result);
        } else {
          result = {};
        }
        result._node = node;
        asyncCb(null, result);
      });
    });
    if (req._body) {
      if (bodies && bodies[node]) {
        preq.end(bodies[node]);
      } else {
        preq.end(req.body);
      }
    }
    preq.on('error', function (e) {
      console.log("Request error with node", node, e);
    });
    preq.end();
  }, doneCb);
}

function shallowCopy(obj1, obj2) {
  for (var attrname in obj2) {
    obj1[attrname] = obj2[attrname];
  }
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function shallowAdd(obj1, obj2) {
  for (var attrname in obj2) {
    if (typeof obj2[attrname] === "number") {
      obj1[attrname] += obj2[attrname];
    }
  }
}

function simpleGatherCopy(req, res) {
  simpleGather(req, res, null, function(err, results) {
    var obj = results[0];
    for (var i = 1; i < results.length; i++) {
      shallowCopy(obj.nodes, results[i].nodes);
    }
    res.send(obj);
  });
}

function simpleGatherAdd(req, res) {
  simpleGather(req, res, null, function(err, results) {
    var obj = results[0];
    for (var i = 1; i < results.length; i++) {
      shallowAdd(obj, results[i]);
    }
    obj.cluster_name = "COMBINED";
    res.send(obj);
  });
}

app.get("/_cluster/nodes/stats", simpleGatherCopy);
app.get("/_nodes/stats", simpleGatherCopy);
app.get("/_cluster/health", simpleGatherAdd);

app.get("/:index/_status", function(req, res) {
  simpleGather(req, res, null, function(err, results) {
    var obj = results[0];
    for (var i = 1; i < results.length; i++) {
      for (var index in results[i].indices) {
        if (obj.indices[index]) {
          obj.indices[index].docs.num_docs += results[i].indices[index].docs.num_docs;
        } else {
          obj.indices[index] = results[i].indices[index];
        }
      }
    }
    res.send(obj);
  });
});

app.get("/dstats/version/version", function(req, res) {
  simpleGather(req, res, null, function(err, results) {
    var obj = results[0];
    for (var i = 1; i < results.length; i++) {
      if (results[i]._source.version < obj._source.version) {
        obj = results[i];
      }
    }
    res.send(obj);
  });
});

app.get("/users/user/:user", function(req, res) {
  clients[nodes[0]].get({index: "users", type: "user", id: req.params.user}, function(err, result) {
    res.send(result);
  });
});

app.get("/:index/:type/_search", function(req, res) {
  simpleGather(req, res, null, function(err, results) {
    var obj = results[0];
    for (var i = 1; i < results.length; i++) {
      obj.hits.total += results[i].hits.total;
      obj.hits.hits = obj.hits.hits.concat(results[i].hits.hits);
    }
    console.log("GET", req.url, obj);
    res.send(obj);
  });
});

app.get("/:index/:type/:id", function(req, res) {
  simpleGather(req, res, null, function(err, results) {
    for (var i = 0; i < results.length; i++) {
      if (results[i].exists) {
        return res.send(results[i]);
      }
    }
    res.send(results[0]);
  });
});


app.head(/^\/$/, function(req, res) {
  res.send("");
});

app.get(/./, function(req, res) {
  simpleGather(req, res, null, function(err, results) {
    console.log("UNKNOWN", req.method, req.url, results);
  });

});


function facet2Obj(field, facet) {
  var obj = {};
  for (var i = 0; i < facet.length; i++) {
    obj[facet[i][field]] = facet[i];
  }
  return obj;
}

function facet2Arr(facet) {
  var arr = [];
  for (var attrname in facet) {
    arr.push(facet[attrname]);
  }
  
  arr = arr.sort(function(a,b) {return b.count - a.count;});
  return arr;
}

function facetConvert2Obj(facets) {
  for (var facetname in facets) {
    if (facets[facetname]._type === "histogram") {
      facets[facetname].entries = facet2Obj("key", facets[facetname].entries);
    } else if (facets[facetname]._type === "terms") {
      facets[facetname].terms = facet2Obj("term", facets[facetname].terms);
    } else {
      console.log("Unknown facet type", facets[facetname]._type);
    }
  }
}

function facetConvert2Arr(facets) {
  for (var facetname in facets) {
    var facetarray = facets[facetname]._type === "histogram"?"entries":"terms";
    facets[facetname][facetarray]= facet2Arr(facets[facetname][facetarray]);

  }
}

function facetAdd(obj1, obj2) {
  for (var facetname in obj2) {
    var facetarray = obj1[facetname]._type === "histogram"?"entries":"terms";

    for (var entry in obj2[facetname][facetarray]) {
      if (!obj1[facetname][facetarray][entry]) {
        obj1[facetname][facetarray][entry] = obj2[facetname][facetarray][entry];
      } else {
        var o1 = obj1[facetname][facetarray][entry];
        var o2 = obj2[facetname][facetarray][entry];

        o1.count += o2.count;
        if (o1.total) {
          o1.total += o2.total;
        }
      }
    }
  }
}

var tags = {};

function tagNameToId(node, name, cb) {
  if (tags[node].tagName2Id[name]) {
    return cb (tags[node].tagName2Id[name]);
  }

  clients[node].get({index: 'tags', type: 'tag', id: name}, function(err, tdata) {
    if (!err && tdata.exists) {
      tags[node].tagName2Id[name] = tdata._source.n;
      tags[node].tagId2Name[tdata._source.n] = name;
      return cb (tags[node].tagName2Id[name]);
    }
    return cb(-1);
  });
}

function tagIdToName (node, id, cb) {
  if (tags[node].tagId2Name[id]) {
    return cb(tags[node].tagId2Name[id]);
  }

  var query = {query: {term: {n:id}}};
  clients[node].search({index: 'tags', type: 'tag', body: query}, function(err, tdata) {
    if (!err && tdata.hits.hits[0]) {
      tags[node].tagId2Name[id] = tdata.hits.hits[0]._id;
      tags[node].tagName2Id[tdata.hits.hits[0]._id] = id;
      return cb(tags[node].tagId2Name[id]);
    }

    return cb(null);
  });
}

function fixQuery(node, body, doneCb) {
  body = JSON.parse(body);

  // Reset from & size since we do aggregation
  if (body.size) {
    body.size = (+body.size) + ((+body.from) || 0);
  }
  body.from = 0;

  var outstanding = 0;
  var finished = 0;
  var err = null;

  function process(parent, obj, item) {
    if ((item === "ta" || item === "hh" || item === "hh1" || item === "hh2") && (typeof obj[item] === "string" || Array.isArray(obj[item]))) {
      if (obj[item].indexOf("*") !== -1) {
        delete parent.wildcard;
        outstanding++;
        var query;
        if (item === "ta") {
          query = {bool: {must: {wildcard: {_id: obj[item]}},
                          must_not: {wildcard: {_id: "http:header:*"}}
                         }
                  };
        } else {
          query = {wildcard: {_id: "http:header:" + obj[item].toLowerCase()}};
        }
        clients[node].search({index: 'tags', type: 'tag', size:500, fields:["id", "n"], body: {query: query}}, function(err, result) {
          var terms = [];
          result.hits.hits.forEach(function (hit) {
            terms.push(hit.fields.n);
          });
          parent.terms = {};
          parent.terms[item] = terms;
          outstanding--;
          if (finished && outstanding === 0) {
            doneCb(err, body);
          }
        });
      } else if (Array.isArray(obj[item])) {
        outstanding++;

        async.map(obj[item], function(str, cb) {
          var tag = (item !== "ta"?"http:header:" + str.toLowerCase():str);
          tagNameToId(node, tag, function (id) {
            if (id === null) {
              cb(null, -1);
            } else {
              cb(null, id);
            }
          });
        },
        function (err, results) {
          outstanding--;
          obj[item] = results;
          if (finished && outstanding === 0) {
            doneCb(err, body);
          }
        });
      } else {
        outstanding++;
        var tag = (item !== "ta"?"http:header:" + obj[item].toLowerCase():obj[item]);

        tagNameToId(node, tag, function (id) {
          outstanding--;
          if (id === null) {
            err = "Tag '" + tag + "' not found";
          } else {
            obj[item] = id;
          }
          if (finished && outstanding === 0) {
            doneCb(err, body);
          }
        });
      }
    /*} else if (item === "fileand" && typeof obj[item] === "string") {
      var name = obj.fileand;
      delete obj.fileand;
      outstanding++;
      Db.fileNameToFile(name, function (file) {
        outstanding--;
        if (file === null) {
          err = "File '" + name + "' not found";
        } else {
          obj.bool = {must: [{term: {no: file.node}}, {term: {fs: file.num}}]};
        }
        if (finished && outstanding === 0) {
          doneCb(err, body);
        }
      });*/
    } else if (typeof obj[item] === "object") {
      convert(obj, obj[item]);
    }
  }

  function convert(parent, obj) {
    for (var item in obj) {
      process(parent, obj, item);
    }
  }

  convert(null, body);
  if (outstanding === 0) {
    return doneCb(err, body);
  }

  finished = 1;
}

function fixResult(node, result, doneCb) {
  if (!result.facets) {
    return doneCb(null);
  }

  function tags(container, field, doneCb) {
    if (!container[field]) {
      return doneCb(null);
    }

    async.map(container[field].terms, function (item, cb) {
      tagIdToName(node, item.term, function (name) {
        item.term = name;
        cb(null, item);
      });
    },
    function(err, tagsResults) {
      container[field].terms = tagsResults;
      doneCb(err);
    });
  }

  async.parallel([
    function(parallelCb) {
      tags(result.facets, "ta", parallelCb);
    },
    function(parallelCb) {
      tags(result.facets, "hh", parallelCb);
    },
    function(parallelCb) {
      tags(result.facets, "hh1", parallelCb);
    },
    function(parallelCb) {
      tags(result.facets, "hh2", parallelCb);
    }], function () {
      doneCb();
    });
}

function combineResults(obj, result) {
  if (!result.hits) {
    console.log("NO RESULTS", result);
    return;
  }
  obj.hits.total += result.hits.total;
  obj.hits.hits = obj.hits.hits.concat(result.hits.hits);
  if (obj.facets) {
    facetConvert2Obj(result.facets);
    facetAdd(obj.facets, result.facets);
  }
}

function sortResults(search, obj) {
  // Resort items
  if (search.sort && search.sort.length > 0) {
    var sortorder = [];
    for (var i = 0; i < search.sort.length; i++) {
      sortorder[i] = search.sort[i][Object.keys(search.sort[i])[0]].order === "asc"? 1:-1;
    }

    obj.hits.hits = obj.hits.hits.sort(function(a, b) {
      for (var i = 0; i < a.sort.length; i++) {
        if (a.sort[i] === b.sort[i]) {
          continue;
        }
        if (typeof a.sort[i] === "string") {
          return sortorder[i] * a.sort[i].localeCompare(b.sort[i]);
        } else {
          return sortorder[i] * (a.sort[i] - b.sort[i]);
        }
      }
      return 0;
    });
  }

  if (search.size) {
    var from = +search.from || 0;
    obj.hits.hits = obj.hits.hits.slice(from, from + (+search.size));
  }
}
function newResult(search) {
  var result = {hits: {hits: [], total: 0}};
  if (search.facets) {
    result.facets = {};
    for (var facet in search.facets) {
      if (search.facets[facet].histogram) {
        result.facets[facet] = {entries: [], _type: "histogram"};
      } else {
        result.facets[facet] = {terms: [], _type: "terms"};
      }
    }
  }
  return result;
}

// Only tags search is for auto complete so unique the results
app.post("/tags/tag/_search", function(req, res) {
  var search = JSON.parse(req.body);

  simpleGather(req, res, null, function(err, results) {
    async.each(results, function (result, asyncCb) {
      fixResult(result._node, result, asyncCb);
    }, function (err) {
      var tags = {};
      for (var i = 0; i < results.length; i++) {
        if (results[i].error || !results[i].hits) {
          console.log("Issue with tag results", results[i].error);
          continue;
        }
        for (var h = 0; h < results[i].hits.hits.length; h++) {
          tags[results[i].hits.hits[h]._id] = results[i].hits.hits[h];
        }
      }
      var obj = results[0];
      obj.hits.hits = [];

      for (var tag in tags) {
        obj.hits.hits.push(tags[tag]);
      }

      res.send(obj);
    });
  });

});

app.post("/fields/field/_search", function(req, res) {
  simpleGather(req, res, null, function(err, results) {
    var obj = {
      hits: {
        total: 0,
        hits: [
        ]
      }
    };
    var unique = {};
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      for (var h = 0; h < result.hits.total; h++) {
        var hit = result.hits.hits[h];
        if (!unique[hit._id]) {
          unique[hit._id] = 1;
          obj.hits.total++;
          obj.hits.hits.push(hit);
        }
      }
    }
    res.send(obj);
  });
});

app.post("/:index/:type/_search", function(req, res) {
  var bodies = {};
  var search = JSON.parse(req.body);
  //console.log("INCOMING SEARCH", util.inspect(search, false, 50));

  async.each(nodes, function (node, asyncCb) {
    fixQuery(node, req.body, function(err, body) {
      //console.log("OUTGOING SEARCH", node, util.inspect(body, false, 50));
      bodies[node] = JSON.stringify(body);
      asyncCb(null);
    });
  }, function (err) {
    simpleGather(req, res, bodies, function(err, results) {
      async.each(results, function (result, asyncCb) {
        fixResult(result._node, result, asyncCb);
      }, function (err) {
        var obj = newResult(search);

        for (var i = 0; i < results.length; i++) {
          combineResults(obj, results[i]);
        }

        if (obj.facets) {
          facetConvert2Arr(obj.facets);
        }

        sortResults(search, obj);

        res.send(obj);
      });
    });
  });
});

function msearch(req, res) {
  var lines = req.body.split(/[\r\n]/);
  var bodies = {};

  async.each(nodes, function (node, nodeCb) {
    var nlines = [];
    async.eachSeries(lines, function (line, lineCb) {
      if (line === "{}" || line === "") {
        nlines.push("{}");
        return lineCb();
      }
      fixQuery(node, line, function(err, body) {
        nlines.push(JSON.stringify(body));
        lineCb();
      });
    }, function(err) {
      bodies[node] = nlines.join("\n");
      nodeCb();
    });
  }, function(err) {
    var responses = [];
    simpleGather(req, res, bodies, function(err, results) {
      async.eachSeries(results, function(result, resultCb) {
        async.eachSeries(result.responses, function(response, responseCb) {
          fixResult(result._node, response, responseCb);
        }, function(err) {
          resultCb();
        });
      }, function(err) {
        var obj = {responses:[]};
        for (var h = 0; h < results[0].responses.length; h++) {
          obj.responses[h] = newResult(JSON.parse(lines[h*2+1]));

          for (var i = 0; i < results.length; i++) {
            combineResults(obj.responses[h], results[i].responses[h]);
          }

          if (obj.responses[h].facets) {
            facetConvert2Arr(obj.responses[h].facets);
          }

          sortResults(JSON.parse(lines[h*2+1]), obj.responses[h]);
        }

        res.send(obj);
      });
    });
  });
}

app.post("/:index/:type/_msearch", msearch);
app.post("/_msearch", msearch);

app.post(/./, function(req, res) {
  console.log("UNKNOWN", req.method, req.url, req.body);
});

//////////////////////////////////////////////////////////////////////////////////
//// Main
//////////////////////////////////////////////////////////////////////////////////

nodes = Config.get("multiESNodes", "").split(";");
if (nodes.length === 0 || nodes[0] === "") {
  console.log("ERROR - Empty multiESNodes");
  process.exit(1);
}

nodes.forEach(function(node) {
  clients[node] = new ESC.Client({
    host: node,
    apiVersion: "0.90"
  });
  tags[node] = {tagName2Id: {}, tagId2Name: {}};
});

console.log(nodes);

console.log("Listen on ", Config.get("multiESPort", "8200"));
var server = http.createServer(app).listen(Config.get("multiESPort", "8200"), Config.get("multiESHost", undefined));
