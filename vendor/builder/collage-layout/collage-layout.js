/**
 * CollageLayout - A JavaScript library for creating beautiful image collages
 * @version 1.0.0
 * @license MIT
 */

(function(global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define(factory);
  } else {
    global.CollageLayout = factory();
  }
}(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  /**
   * Default configuration options
   */
  var DEFAULTS = {
    // Canvas dimensions
    width: 2480,
    height: 3508,
    
    // Spacing
    padding: 100,        // Padding from edges
    gap: 100,            // Gap between images
    edgeGap: 100,        // Minimum gap from edges after rotation
    rotationGap: 50,     // Minimum gap between images after rotation
    
    // Rotation
    rotationMin: -12,    // Minimum rotation angle (degrees)
    rotationMax: 12,     // Maximum rotation angle (degrees)
    
    // Algorithm
    iterations: 500,     // Number of layout iterations to try
    
    // Display scale (for rendering)
    scale: 0.22
  };

  /**
   * CollageLayout constructor
   * @param {Object} options - Configuration options
   */
  function CollageLayout(options) {
    this.options = extend({}, DEFAULTS, options || {});
    this.images = [];
  }

  /**
   * Extend object with properties from other objects
   */
  function extend(target) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (source) {
        for (var key in source) {
          if (source.hasOwnProperty(key)) {
            target[key] = source[key];
          }
        }
      }
    }
    return target;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Add an image to the collage
   * @param {Object} image - Image object with width and height
   * @param {number} image.width - Image width
   * @param {number} image.height - Image height
   * @param {*} [image.data] - Optional custom data to attach
   * @returns {CollageLayout} - Returns this for chaining
   */
  CollageLayout.prototype.addImage = function(image) {
    this.images.push({
      width: image.width,
      height: image.height,
      data: image.data || null
    });
    return this;
  };

  /**
   * Add multiple images at once
   * @param {Array} images - Array of image objects
   * @returns {CollageLayout} - Returns this for chaining
   */
  CollageLayout.prototype.addImages = function(images) {
    for (var i = 0; i < images.length; i++) {
      this.addImage(images[i]);
    }
    return this;
  };

  /**
   * Clear all images
   * @returns {CollageLayout} - Returns this for chaining
   */
  CollageLayout.prototype.clear = function() {
    this.images = [];
    return this;
  };

  /**
   * Set configuration option(s)
   * @param {string|Object} key - Option key or object with multiple options
   * @param {*} [value] - Option value (if key is string)
   * @returns {CollageLayout} - Returns this for chaining
   */
  CollageLayout.prototype.setOption = function(key, value) {
    if (typeof key === 'object') {
      extend(this.options, key);
    } else {
      this.options[key] = value;
    }
    return this;
  };

  /**
   * Calculate the layout
   * @returns {Object} - Layout result with positions and dimensions
   */
  CollageLayout.prototype.calculate = function() {
    var opts = this.options;
    var availableWidth = opts.width - 2 * opts.padding;
    var availableHeight = opts.height - 2 * opts.padding;

    if (this.images.length === 0) {
      return { items: [], coverage: 0, bounds: { width: 0, height: 0 } };
    }

    // Find best layout
    var layout = findBestLayout(
      this.images,
      availableWidth,
      availableHeight,
      opts
    );

    if (!layout) {
      layout = findBestLayoutFallback(this.images, availableWidth, availableHeight, opts);
    }

    // Optimize rotations
    if (layout) {
      layout = optimizeRotations(layout, availableWidth, availableHeight, opts);
    }

    // Apply distribution and centering
    if (layout) {
      layout = centerLayout(layout, availableWidth, availableHeight, opts);
    }

    // Calculate coverage
    var totalArea = 0;
    var bounds = { minX: Infinity, minY: Infinity, maxX: 0, maxY: 0 };
    
    if (layout) {
      layout.forEach(function(item) {
        totalArea += item.w * item.h;
        bounds.minX = Math.min(bounds.minX, item.x);
        bounds.minY = Math.min(bounds.minY, item.y);
        bounds.maxX = Math.max(bounds.maxX, item.x + item.w);
        bounds.maxY = Math.max(bounds.maxY, item.y + item.h);
      });
    }

    var coverage = totalArea / (availableWidth * availableHeight);

    // Map layout items to include original image data
    var self = this;
    var items = layout ? layout.map(function(item) {
      return {
        x: opts.padding + item.x,
        y: opts.padding + item.y,
        width: item.w,
        height: item.h,
        rotation: item.rotation,
        index: item.index,
        image: self.images[item.index]
      };
    }) : [];

    return {
      items: items,
      coverage: coverage,
      bounds: {
        x: opts.padding + (bounds.minX === Infinity ? 0 : bounds.minX),
        y: opts.padding + (bounds.minY === Infinity ? 0 : bounds.minY),
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY
      },
      canvas: {
        width: opts.width,
        height: opts.height
      }
    };
  };

  /**
   * Generate random aspect ratios for testing
   * @param {number} count - Number of images to generate
   * @returns {CollageLayout} - Returns this for chaining
   */
  CollageLayout.prototype.generateRandom = function(count) {
    var RATIOS = [
      { w: 4, h: 3 }, { w: 3, h: 4 }, { w: 16, h: 9 }, { w: 9, h: 16 },
      { w: 1, h: 1 }, { w: 3, h: 2 }, { w: 2, h: 3 }, { w: 5, h: 4 },
      { w: 4, h: 5 }, { w: 2, h: 1 }
    ];

    this.clear();
    for (var i = 0; i < count; i++) {
      var ratio = RATIOS[Math.floor(Math.random() * RATIOS.length)];
      var baseSize = 800 + Math.random() * 400;
      this.addImage({
        width: Math.round(ratio.w * baseSize / Math.max(ratio.w, ratio.h)),
        height: Math.round(ratio.h * baseSize / Math.max(ratio.w, ratio.h))
      });
    }
    return this;
  };

  // ============================================
  // Internal: Bin Packer
  // ============================================

  function BinPacker(width, height) {
    this.root = { x: 0, y: 0, w: width, h: height };
  }

  BinPacker.prototype.fit = function(blocks) {
    var results = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var node = this.findNode(this.root, block.w, block.h);
      if (node) {
        var fit = this.splitNode(node, block.w, block.h);
        results.push({ x: fit.x, y: fit.y, w: block.w, h: block.h, originalIndex: block.originalIndex });
      } else {
        results.push(null);
      }
    }
    return results;
  };

  BinPacker.prototype.findNode = function(root, w, h) {
    if (root.used) {
      return this.findNode(root.right, w, h) || this.findNode(root.down, w, h);
    } else if (w <= root.w && h <= root.h) {
      return root;
    }
    return null;
  };

  BinPacker.prototype.splitNode = function(node, w, h) {
    node.used = true;
    node.down = { x: node.x, y: node.y + h + 100, w: node.w, h: node.h - h - 100 };
    node.right = { x: node.x + w + 100, y: node.y, w: node.w - w - 100, h: h };
    return node;
  };

  // ============================================
  // Internal: Layout Algorithms
  // ============================================

  function calculateOptimalSizes(imageData, availableWidth, availableHeight, opts) {
    if (imageData.length === 0) return [];

    var totalArea = availableWidth * availableHeight;
    var coverageTarget = Math.max(0.5, Math.min(0.85, 1.0 - imageData.length * 0.03));
    var targetAreaPerImage = totalArea / imageData.length * coverageTarget;

    var sized = imageData.map(function(item) {
      var img = item.img;
      var ratio = img.width / img.height;
      var h = Math.sqrt(targetAreaPerImage / ratio);
      var w = ratio * h;
      return { w: w, h: h, ratio: ratio, originalIndex: item.originalIndex, original: img };
    });

    // Normalize sizes
    var areas = sized.map(function(s) { return s.w * s.h; });
    var minArea = Math.min.apply(null, areas);
    var maxArea = Math.max.apply(null, areas);

    if (maxArea / minArea > 4) {
      var avgArea = areas.reduce(function(a, b) { return a + b; }, 0) / areas.length;
      sized = sized.map(function(s) {
        var currentArea = s.w * s.h;
        var targetArea = currentArea;

        if (currentArea > avgArea * 2.5) {
          targetArea = avgArea * 2;
        } else if (currentArea < avgArea * 0.4) {
          targetArea = avgArea * 0.6;
        }

        var h = Math.sqrt(targetArea / s.ratio);
        var w = s.ratio * h;
        return { w: w, h: h, ratio: s.ratio, originalIndex: s.originalIndex, original: s.original };
      });
    }

    return sized;
  }

  function findBestLayout(imageData, availableWidth, availableHeight, opts) {
    var bestLayout = null;
    var bestScore = 0;
    var iterations = opts.iterations || 500;

    var sortStrategies = [
      function(a, b) { return (b.w * b.h) - (a.w * a.h); },
      function(a, b) { return b.h - a.h; },
      function(a, b) { return b.w - a.w; },
      function(a, b) { return (b.w / b.h) - (a.w / a.h); },
      function(a, b) { return (a.w / a.h) - (b.w / b.h); },
      function(a, b) { return Math.max(b.w, b.h) - Math.max(a.w, a.h); }
    ];

    var scaleFactors = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2];

    for (var iter = 0; iter < iterations; iter++) {
      var wrapped = imageData.map(function(img, i) { return { img: img, originalIndex: i }; });

      if (iter % 3 !== 0) {
        for (var i = wrapped.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var temp = wrapped[i];
          wrapped[i] = wrapped[j];
          wrapped[j] = temp;
        }
      }

      var scaleFactor = scaleFactors[iter % scaleFactors.length];
      var sized = calculateOptimalSizes(wrapped, availableWidth, availableHeight, opts);

      sized = sized.map(function(s) {
        return {
          w: Math.round(s.w * scaleFactor),
          h: Math.round(s.h * scaleFactor),
          originalIndex: s.originalIndex,
          original: s.original
        };
      });

      var sortFn = sortStrategies[iter % sortStrategies.length];
      sized.sort(sortFn);

      var packer = new BinPacker(availableWidth, availableHeight);
      var results = packer.fit(sized);

      var allFit = results.every(function(r) { return r !== null; });
      if (allFit) {
        var coverage = results.reduce(function(sum, r) { return sum + r.w * r.h; }, 0);
        var totalArea = availableWidth * availableHeight;
        var coverageRatio = coverage / totalArea;

        var minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
        results.forEach(function(r) {
          minX = Math.min(minX, r.x);
          minY = Math.min(minY, r.y);
          maxX = Math.max(maxX, r.x + r.w);
          maxY = Math.max(maxY, r.y + r.h);
        });
        var boundingArea = (maxX - minX) * (maxY - minY);
        var density = coverage / boundingArea;

        var areas = results.map(function(r) { return r.w * r.h; });
        var minA = Math.min.apply(null, areas);
        var maxA = Math.max.apply(null, areas);
        var sizeBalance = minA / maxA;

        var score = coverageRatio * 2 + density * 0.5 + sizeBalance * 0.2;

        if (score > bestScore) {
          bestScore = score;
          bestLayout = results.map(function(r) {
            return { x: r.x, y: r.y, w: r.w, h: r.h, index: r.originalIndex, rotation: 0 };
          });
        }
      }
    }

    // Try grid layouts
    var gridLayouts = tryGridLayouts(imageData, availableWidth, availableHeight, opts);
    gridLayouts.forEach(function(gridLayout) {
      var coverage = gridLayout.reduce(function(sum, item) { return sum + item.w * item.h; }, 0);
      var totalArea = availableWidth * availableHeight;
      var coverageRatio = coverage / totalArea;
      var score = coverageRatio * 2;

      if (score > bestScore) {
        bestScore = score;
        bestLayout = gridLayout;
      }
    });

    // Scale up if possible
    if (bestLayout) {
      bestLayout = scaleUpLayout(bestLayout, availableWidth, availableHeight, opts);
    }

    return bestLayout;
  }

  function tryGridLayouts(imageData, availableWidth, availableHeight, opts) {
    var layouts = [];
    var count = imageData.length;
    if (count === 0) return layouts;

    var gap = opts.gap || 100;
    var edgeGap = opts.edgeGap || 100;

    var gridConfigs = [];
    for (var cols = 1; cols <= Math.min(count, 4); cols++) {
      var rows = Math.ceil(count / cols);
      if (rows <= 6) {
        gridConfigs.push({ cols: cols, rows: rows });
      }
    }

    gridConfigs.forEach(function(config) {
      var cols = config.cols;
      var rows = config.rows;

      var totalGapX = gap * (cols - 1) + 2 * edgeGap;
      var totalGapY = gap * (rows - 1) + 2 * edgeGap;
      var cellWidth = (availableWidth - totalGapX) / cols;
      var cellHeight = (availableHeight - totalGapY) / rows;

      var layout = [];

      for (var i = 0; i < imageData.length; i++) {
        var img = imageData[i];
        var col = i % cols;
        var row = Math.floor(i / cols);

        var ratio = img.width / img.height;
        var w, h;

        if (ratio > cellWidth / cellHeight) {
          w = cellWidth;
          h = w / ratio;
        } else {
          h = cellHeight;
          w = h * ratio;
        }

        var cellX = edgeGap + col * (cellWidth + gap);
        var cellY = edgeGap + row * (cellHeight + gap);
        var x = cellX + (cellWidth - w) / 2;
        var y = cellY + (cellHeight - h) / 2;

        layout.push({ x: x, y: y, w: w, h: h, index: i, rotation: 0 });
      }

      if (layout.length === imageData.length) {
        layouts.push(layout);
      }
    });

    return layouts;
  }

  function scaleUpLayout(layout, availableWidth, availableHeight, opts) {
    if (layout.length === 0) return layout;

    var edgeGap = opts.edgeGap || 100;

    var minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    layout.forEach(function(item) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.w);
      maxY = Math.max(maxY, item.y + item.h);
    });

    var contentWidth = maxX - minX;
    var contentHeight = maxY - minY;

    var maxWidth = availableWidth - 2 * edgeGap;
    var maxHeight = availableHeight - 2 * edgeGap;

    var scaleX = maxWidth / contentWidth;
    var scaleY = maxHeight / contentHeight;
    var scale = Math.min(scaleX, scaleY, 1.5);

    if (scale <= 1.05) return layout;

    var centerX = (minX + maxX) / 2;
    var centerY = (minY + maxY) / 2;

    return layout.map(function(item) {
      var itemCenterX = item.x + item.w / 2;
      var itemCenterY = item.y + item.h / 2;

      var newCenterX = centerX + (itemCenterX - centerX) * scale;
      var newCenterY = centerY + (itemCenterY - centerY) * scale;
      var newW = item.w * scale;
      var newH = item.h * scale;

      return {
        x: newCenterX - newW / 2,
        y: newCenterY - newH / 2,
        w: newW,
        h: newH,
        index: item.index,
        rotation: item.rotation
      };
    });
  }

  function findBestLayoutFallback(imageData, availableWidth, availableHeight, opts) {
    var count = imageData.length;
    var gap = opts.gap || 100;

    var cols = Math.ceil(Math.sqrt(count * availableWidth / availableHeight));
    var rows = Math.ceil(count / cols);

    var cellWidth = (availableWidth - gap * (cols - 1)) / cols;
    var cellHeight = (availableHeight - gap * (rows - 1)) / rows;

    var results = [];
    for (var i = 0; i < imageData.length; i++) {
      var col = i % cols;
      var row = Math.floor(i / cols);
      var img = imageData[i];
      var ratio = img.width / img.height;

      var w, h;
      if (ratio > cellWidth / cellHeight) {
        w = cellWidth;
        h = w / ratio;
      } else {
        h = cellHeight;
        w = h * ratio;
      }

      var x = col * (cellWidth + gap) + (cellWidth - w) / 2;
      var y = row * (cellHeight + gap) + (cellHeight - h) / 2;

      results.push({ x: x, y: y, w: w, h: h, index: i, rotation: 0 });
    }

    return results;
  }

  // ============================================
  // Internal: Rotation Optimization
  // ============================================

  function getRotatedBoundingBox(x, y, w, h, angleDeg) {
    var angle = angleDeg * Math.PI / 180;
    var cos = Math.abs(Math.cos(angle));
    var sin = Math.abs(Math.sin(angle));

    var rotW = w * cos + h * sin;
    var rotH = w * sin + h * cos;

    var cx = x + w / 2;
    var cy = y + h / 2;

    return { x: cx - rotW / 2, y: cy - rotH / 2, w: rotW, h: rotH };
  }

  function rectanglesOverlap(rect1, rect2, minGap) {
    return !(rect1.x + rect1.w + minGap <= rect2.x ||
             rect2.x + rect2.w + minGap <= rect1.x ||
             rect1.y + rect1.h + minGap <= rect2.y ||
             rect2.y + rect2.h + minGap <= rect1.y);
  }

  function hasOverlaps(layout, minGap) {
    var rotatedBoxes = layout.map(function(item) {
      return getRotatedBoundingBox(item.x, item.y, item.w, item.h, item.rotation);
    });

    for (var i = 0; i < rotatedBoxes.length; i++) {
      for (var j = i + 1; j < rotatedBoxes.length; j++) {
        if (rectanglesOverlap(rotatedBoxes[i], rotatedBoxes[j], minGap)) {
          return true;
        }
      }
    }
    return false;
  }

  function optimizeRotations(layout, availableWidth, availableHeight, opts) {
    var minGap = opts.rotationGap || 50;
    var rotMin = opts.rotationMin || -12;
    var rotMax = opts.rotationMax || 12;
    var bestLayout = null;
    var bestScore = -Infinity;

    // Special case: single image always gets artistic rotation
    if (layout.length === 1) {
      var item = layout[0];
      var rotation = rotMin + Math.random() * (rotMax - rotMin);
      return [{
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        index: item.index,
        rotation: rotation
      }];
    }

    var zeroRotLayout = layout.map(function(item) {
      return { x: item.x, y: item.y, w: item.w, h: item.h, index: item.index, rotation: 0 };
    });
    if (!hasOverlaps(zeroRotLayout, minGap)) {
      bestLayout = zeroRotLayout;
      bestScore = 0;
    }

    var strategies = ['random', 'alternating', 'same_direction', 'small_random', 'gradient'];
    var rotationScales = [1.0, 0.75, 0.5, 0.25];

    for (var scaleIdx = 0; scaleIdx < rotationScales.length; scaleIdx++) {
      var rotScale = rotationScales[scaleIdx];
      var scaledMin = rotMin * rotScale;
      var scaledMax = rotMax * rotScale;

      for (var stratIdx = 0; stratIdx < strategies.length; stratIdx++) {
        var strategy = strategies[stratIdx];

        for (var iter = 0; iter < 100; iter++) {
          var testLayout = generateRotations(layout, scaledMin, scaledMax, strategy, iter);

          if (hasOverlaps(testLayout, minGap)) {
            continue;
          }

          var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          testLayout.forEach(function(item) {
            var rotBB = getRotatedBoundingBox(item.x, item.y, item.w, item.h, item.rotation);
            minX = Math.min(minX, rotBB.x);
            minY = Math.min(minY, rotBB.y);
            maxX = Math.max(maxX, rotBB.x + rotBB.w);
            maxY = Math.max(maxY, rotBB.y + rotBB.h);
          });

          var boundingWidth = maxX - minX;
          var boundingHeight = maxY - minY;
          var boundingArea = boundingWidth * boundingHeight;

          var contentArea = testLayout.reduce(function(sum, item) {
            return sum + item.w * item.h;
          }, 0);

          var density = contentArea / boundingArea;
          var hasRotation = testLayout.some(function(item) { return Math.abs(item.rotation) > 1; });
          var rotationBonus = hasRotation ? 0.1 * rotScale : 0;
          var score = density + rotationBonus;

          if (score > bestScore) {
            bestScore = score;
            bestLayout = testLayout;
          }
        }
      }

      var foundRotated = bestLayout && bestLayout.some(function(item) { return Math.abs(item.rotation) > 1; });
      if (foundRotated) break;
    }

    return bestLayout;
  }

  function generateRotations(layout, rotMin, rotMax, strategy, seed) {
    return layout.map(function(item, index) {
      var rotation = 0;
      var range = rotMax - rotMin;

      switch (strategy) {
        case 'random':
          rotation = rotMin + Math.random() * range;
          break;
        case 'alternating':
          var magnitude = Math.random() * rotMax;
          rotation = (index % 2 === 0) ? magnitude : -magnitude;
          break;
        case 'same_direction':
          var direction = (seed % 2 === 0) ? 1 : -1;
          rotation = direction * Math.random() * rotMax;
          break;
        case 'small_random':
          rotation = (Math.random() - 0.5) * range * 0.5;
          break;
        case 'gradient':
          var t = layout.length > 1 ? index / (layout.length - 1) : 0.5;
          var base = rotMin + t * range;
          rotation = base + (Math.random() - 0.5) * range * 0.3;
          break;
      }

      return { x: item.x, y: item.y, w: item.w, h: item.h, index: item.index, rotation: rotation };
    });
  }

  // ============================================
  // Internal: Distribution & Centering
  // ============================================

  function groupIntoRows(layout) {
    if (layout.length === 0) return [];

    var sorted = layout.map(function(item, idx) { return { item: item, idx: idx }; });
    sorted.sort(function(a, b) {
      return (a.item.y + a.item.h / 2) - (b.item.y + b.item.h / 2);
    });

    var rows = [];
    var currentRow = [sorted[0]];
    var rowCenterY = sorted[0].item.y + sorted[0].item.h / 2;

    for (var i = 1; i < sorted.length; i++) {
      var item = sorted[i];
      var itemCenterY = item.item.y + item.item.h / 2;

      var rowHeight = Math.max.apply(null, currentRow.map(function(r) { return r.item.h; }));
      var threshold = rowHeight * 0.5;

      if (Math.abs(itemCenterY - rowCenterY) < threshold) {
        currentRow.push(item);
        rowCenterY = currentRow.reduce(function(sum, r) {
          return sum + r.item.y + r.item.h / 2;
        }, 0) / currentRow.length;
      } else {
        rows.push(currentRow);
        currentRow = [item];
        rowCenterY = itemCenterY;
      }
    }
    rows.push(currentRow);

    return rows;
  }

  function distributeHorizontally(layout, availableWidth, opts) {
    if (layout.length === 0) return layout;

    var gap = opts.gap || 100;
    var edgeGap = opts.edgeGap || 100;
    var rows = groupIntoRows(layout);
    var result = layout.slice();

    rows.forEach(function(row) {
      row.sort(function(a, b) { return a.item.x - b.item.x; });

      var totalWidth = row.reduce(function(sum, r) { return sum + r.item.w; }, 0);
      var availableForContent = availableWidth - 2 * edgeGap;
      var remainingSpace = availableForContent - totalWidth;

      var gapSize, startX;

      if (row.length === 1) {
        gapSize = 0;
        startX = (availableWidth - row[0].item.w) / 2;
      } else {
        var numGaps = row.length - 1;
        gapSize = remainingSpace / (numGaps + 2);
        gapSize = Math.max(gapSize, gap);

        var rowWidth = totalWidth + gapSize * numGaps;
        startX = (availableWidth - rowWidth) / 2;
      }

      var x = startX;
      row.forEach(function(r) {
        result[r.idx] = {
          x: x,
          y: r.item.y,
          w: r.item.w,
          h: r.item.h,
          index: r.item.index,
          rotation: r.item.rotation
        };
        x += r.item.w + gapSize;
      });
    });

    return result;
  }

  function distributeVertically(layout, availableHeight, opts) {
    if (layout.length === 0) return layout;

    var gap = opts.gap || 100;
    var edgeGap = opts.edgeGap || 100;
    var rows = groupIntoRows(layout);
    if (rows.length === 0) return layout;

    var result = layout.slice();

    var rowData = rows.map(function(row) {
      var maxH = Math.max.apply(null, row.map(function(r) { return r.item.h; }));
      return { row: row, height: maxH };
    });

    var totalRowsHeight = rowData.reduce(function(sum, rd) { return sum + rd.height; }, 0);
    var availableForContent = availableHeight - 2 * edgeGap;
    var remainingSpace = availableForContent - totalRowsHeight;

    var gapSize, startY;

    if (rows.length === 1) {
      gapSize = 0;
      startY = (availableHeight - totalRowsHeight) / 2;
    } else {
      var numGaps = rows.length - 1;
      gapSize = remainingSpace / (numGaps + 2);
      gapSize = Math.max(gapSize, gap);

      var contentHeight = totalRowsHeight + gapSize * numGaps;
      startY = (availableHeight - contentHeight) / 2;
    }

    startY = Math.max(startY, edgeGap);

    var y = startY;
    rowData.forEach(function(rd) {
      rd.row.forEach(function(r) {
        var offsetY = (rd.height - r.item.h) / 2;
        result[r.idx] = {
          x: result[r.idx].x,
          y: y + offsetY,
          w: r.item.w,
          h: r.item.h,
          index: r.item.index,
          rotation: r.item.rotation
        };
      });
      y += rd.height + gapSize;
    });

    return result;
  }

  function resolveOverlaps(layout, availableWidth, availableHeight, opts) {
    var rotationGap = opts.rotationGap || 50;
    var maxIterations = 10;
    var minScale = 0.5;

    for (var iter = 0; iter < maxIterations; iter++) {
      if (!hasOverlaps(layout, rotationGap)) {
        break;
      }

      layout = layout.map(function(item) {
        var cx = item.x + item.w / 2;
        var cy = item.y + item.h / 2;
        var newW = item.w * 0.95;
        var newH = item.h * 0.95;
        return {
          x: cx - newW / 2,
          y: cy - newH / 2,
          w: newW,
          h: newH,
          index: item.index,
          rotation: item.rotation
        };
      });
    }

    return layout;
  }

  function ensureWithinBounds(layout, availableWidth, availableHeight, opts) {
    var edgeGap = opts.edgeGap || 100;

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    layout.forEach(function(item) {
      var rotBB = getRotatedBoundingBox(item.x, item.y, item.w, item.h, item.rotation);
      minX = Math.min(minX, rotBB.x);
      minY = Math.min(minY, rotBB.y);
      maxX = Math.max(maxX, rotBB.x + rotBB.w);
      maxY = Math.max(maxY, rotBB.y + rotBB.h);
    });

    var contentWidth = maxX - minX;
    var contentHeight = maxY - minY;
    var maxAllowedWidth = availableWidth - 2 * edgeGap;
    var maxAllowedHeight = availableHeight - 2 * edgeGap;

    var scale = 1;
    if (contentWidth > maxAllowedWidth || contentHeight > maxAllowedHeight) {
      scale = Math.min(maxAllowedWidth / contentWidth, maxAllowedHeight / contentHeight);
    }

    if (scale < 1) {
      var centerX = (minX + maxX) / 2;
      var centerY = (minY + maxY) / 2;

      layout = layout.map(function(item) {
        var newX = centerX + (item.x - centerX + item.w / 2) * scale - (item.w * scale) / 2;
        var newY = centerY + (item.y - centerY + item.h / 2) * scale - (item.h * scale) / 2;
        return {
          x: newX,
          y: newY,
          w: item.w * scale,
          h: item.h * scale,
          index: item.index,
          rotation: item.rotation
        };
      });

      minX = Infinity; minY = Infinity;
      maxX = -Infinity; maxY = -Infinity;
      layout.forEach(function(item) {
        var rotBB = getRotatedBoundingBox(item.x, item.y, item.w, item.h, item.rotation);
        minX = Math.min(minX, rotBB.x);
        minY = Math.min(minY, rotBB.y);
        maxX = Math.max(maxX, rotBB.x + rotBB.w);
        maxY = Math.max(maxY, rotBB.y + rotBB.h);
      });
    }

    var adjustX = 0;
    var adjustY = 0;

    if (minX < edgeGap) {
      adjustX = edgeGap - minX;
    }
    if (maxX + adjustX > availableWidth - edgeGap) {
      adjustX = (availableWidth - edgeGap) - maxX;
    }

    if (minY < edgeGap) {
      adjustY = edgeGap - minY;
    }
    if (maxY + adjustY > availableHeight - edgeGap) {
      adjustY = (availableHeight - edgeGap) - maxY;
    }

    if (adjustX !== 0 || adjustY !== 0) {
      layout = layout.map(function(item) {
        return {
          x: item.x + adjustX,
          y: item.y + adjustY,
          w: item.w,
          h: item.h,
          index: item.index,
          rotation: item.rotation
        };
      });
    }

    return layout;
  }

  function centerLayout(layout, availableWidth, availableHeight, opts) {
    if (!layout || layout.length === 0) return layout;

    var rotationGap = opts.rotationGap || 50;

    // Special case: single image - center based on rotated bounding box
    if (layout.length === 1) {
      var item = layout[0];
      
      // Calculate the rotated bounding box
      var rotBB = getRotatedBoundingBox(item.x, item.y, item.w, item.h, item.rotation);
      
      // Check if we need to scale down to fit within bounds
      var edgeGap = opts.edgeGap || 100;
      var maxAllowedWidth = availableWidth - 2 * edgeGap;
      var maxAllowedHeight = availableHeight - 2 * edgeGap;
      var scale = 1;
      
      if (rotBB.w > maxAllowedWidth || rotBB.h > maxAllowedHeight) {
        scale = Math.min(maxAllowedWidth / rotBB.w, maxAllowedHeight / rotBB.h);
      }
      
      var newW = item.w * scale;
      var newH = item.h * scale;
      
      // Calculate new rotated bounding box dimensions after scaling
      var newRotBB = getRotatedBoundingBox(0, 0, newW, newH, item.rotation);
      
      // Center the item so its rotated bounding box is centered in the available area
      // The item center equals the rotated BB center, so position the item such that
      // item center = (availableWidth/2, availableHeight/2)
      var newX = (availableWidth - newW) / 2;
      var newY = (availableHeight - newH) / 2;
      
      return [{
        x: newX,
        y: newY,
        w: newW,
        h: newH,
        index: item.index,
        rotation: item.rotation
      }];
    }

    layout = resolveOverlaps(layout, availableWidth, availableHeight, opts);
    layout = distributeHorizontally(layout, availableWidth, opts);

    if (hasOverlaps(layout, rotationGap)) {
      layout = resolveOverlaps(layout, availableWidth, availableHeight, opts);
    }

    layout = distributeVertically(layout, availableHeight, opts);

    if (hasOverlaps(layout, rotationGap)) {
      layout = resolveOverlaps(layout, availableWidth, availableHeight, opts);
    }

    layout = ensureWithinBounds(layout, availableWidth, availableHeight, opts);

    var randomOffsetX = (Math.random() - 0.5) * availableWidth * 0.015;
    var randomOffsetY = (Math.random() - 0.5) * availableHeight * 0.015;

    layout = layout.map(function(item) {
      return {
        x: item.x + randomOffsetX,
        y: item.y + randomOffsetY,
        w: item.w,
        h: item.h,
        index: item.index,
        rotation: item.rotation
      };
    });

    layout = ensureWithinBounds(layout, availableWidth, availableHeight, opts);

    return layout;
  }

  // ============================================
  // Static methods
  // ============================================

  /**
   * Create a new CollageLayout instance
   * @static
   * @param {Object} options - Configuration options
   * @returns {CollageLayout}
   */
  CollageLayout.create = function(options) {
    return new CollageLayout(options);
  };

  /**
   * Library version
   */
  CollageLayout.VERSION = '1.0.0';

  return CollageLayout;
}));


