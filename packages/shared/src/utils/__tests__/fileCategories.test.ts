import {
  AUDIO_EXTENSIONS,
  DEFAULT_TEXT_VIEWABLE_EXTENSIONS,
  HTML_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  MOBILE_TEXT_VIEWABLE_EXTENSIONS,
  PDF_EXTENSIONS,
  TEXT_EXTENSIONS,
  TUTORIAL_EXTENSIONS,
  VIDEO_EXTENSIONS,
  getFilePreviewCategory,
  getFilePrivacy,
  getImageMimeType,
  isAudioPath,
  isHtmlPath,
  isImagePath,
  isMarkdownPath,
  isPdfPath,
  isPreviewablePath,
  isTextPath,
  isTutorialPath,
  isVideoPath,
} from '../fileCategories';

describe('fileCategories', () => {
  describe('extension sets', () => {
    for (const extension of TEXT_EXTENSIONS) {
      it(`treats .${extension} as text`, () => {
        expect(isTextPath(`file.${extension}`)).toBe(true);
      });
    }

    for (const extension of IMAGE_EXTENSIONS) {
      it(`treats .${extension} as image`, () => {
        expect(isImagePath(`file.${extension}`)).toBe(true);
      });
    }

    for (const extension of VIDEO_EXTENSIONS) {
      it(`treats .${extension} as video`, () => {
        expect(isVideoPath(`file.${extension}`)).toBe(true);
      });
    }

    for (const extension of AUDIO_EXTENSIONS) {
      it(`treats .${extension} as audio`, () => {
        expect(isAudioPath(`file.${extension}`)).toBe(true);
      });
    }

    for (const extension of HTML_EXTENSIONS) {
      it(`treats .${extension} as html`, () => {
        expect(isHtmlPath(`file.${extension}`)).toBe(true);
      });
    }

    for (const extension of PDF_EXTENSIONS) {
      it(`treats .${extension} as pdf`, () => {
        expect(isPdfPath(`file.${extension}`)).toBe(true);
      });
    }

    for (const extension of MARKDOWN_EXTENSIONS) {
      it(`treats .${extension} as markdown`, () => {
        expect(isMarkdownPath(`file.${extension}`)).toBe(true);
      });
    }

    for (const extension of TUTORIAL_EXTENSIONS) {
      it(`treats tutorial .${extension} files as tutorials`, () => {
        expect(isTutorialPath(`rebel-system/help-for-humans/tutorials/guide.${extension}`)).toBe(true);
      });
    }
  });

  describe('DEFAULT_TEXT_VIEWABLE_EXTENSIONS', () => {
    it('includes the shared text extensions and mobile-specific extras', () => {
      expect(DEFAULT_TEXT_VIEWABLE_EXTENSIONS.has('md')).toBe(true);
      expect(DEFAULT_TEXT_VIEWABLE_EXTENSIONS.has('markdown')).toBe(true);
      expect(DEFAULT_TEXT_VIEWABLE_EXTENSIONS.has('html')).toBe(true);
      expect(DEFAULT_TEXT_VIEWABLE_EXTENSIONS.has('htm')).toBe(true);
      expect(DEFAULT_TEXT_VIEWABLE_EXTENSIONS.has('py')).toBe(true);
      expect(DEFAULT_TEXT_VIEWABLE_EXTENSIONS.has('css')).toBe(true);
      expect(DEFAULT_TEXT_VIEWABLE_EXTENSIONS.has('svg')).toBe(true);
      expect(DEFAULT_TEXT_VIEWABLE_EXTENSIONS.has('gitignore')).toBe(true);
    });
  });

  describe('MOBILE_TEXT_VIEWABLE_EXTENSIONS', () => {
    it('excludes html, htm, svg to force category-aware errors', () => {
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('html')).toBe(false);
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('htm')).toBe(false);
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('svg')).toBe(false);
    });

    it('includes text types', () => {
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('md')).toBe(true);
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('txt')).toBe(true);
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('json')).toBe(true);
    });

    it('includes code types', () => {
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('ts')).toBe(true);
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('py')).toBe(true);
      expect(MOBILE_TEXT_VIEWABLE_EXTENSIONS.has('css')).toBe(true);
    });
  });

  describe('isPreviewablePath', () => {
    const previewableExtensions = [
      ...TEXT_EXTENSIONS,
      ...IMAGE_EXTENSIONS,
      ...VIDEO_EXTENSIONS,
      ...AUDIO_EXTENSIONS,
      ...HTML_EXTENSIONS,
      ...PDF_EXTENSIONS,
    ];

    for (const extension of previewableExtensions) {
      it(`returns true for .${extension}`, () => {
        expect(isPreviewablePath(`file.${extension}`)).toBe(true);
      });
    }

    it('returns false for unsupported extensions', () => {
      expect(isPreviewablePath('file.docx')).toBe(false);
      expect(isPreviewablePath('archive.zip')).toBe(false);
      expect(isPreviewablePath('Makefile')).toBe(false);
    });

    // Contract pinning: the security invariant #5 lists an explicit allowlist.
    // This test must fail if any allowed extension is accidentally dropped from
    // the underlying *_EXTENSIONS sets (and thus from isPreviewablePath).
    // Do NOT derive the list from the implementation — that hides regressions.
    const INVARIANT_5_ALLOWLIST = [
      'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'xml', 'csv', 'log',
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
      'mp4', 'webm', 'mov', 'm4v',
      'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac',
      'html', 'htm',
      'pdf',
    ];
    for (const extension of INVARIANT_5_ALLOWLIST) {
      it(`[contract invariant #5] preserves .${extension} in the previewable allowlist`, () => {
        expect(isPreviewablePath(`file.${extension}`)).toBe(true);
      });
    }
  });

  describe('getFilePreviewCategory', () => {
    it('returns the exact category values used by current desktop consumers', () => {
      expect(getFilePreviewCategory('notes.md')).toBe('text');
      expect(getFilePreviewCategory('photo.png')).toBe('image');
      expect(getFilePreviewCategory('clip.mp4')).toBe('video');
      expect(getFilePreviewCategory('recording.mp3')).toBe('audio');
      expect(getFilePreviewCategory('page.html')).toBe('html');
      expect(getFilePreviewCategory('paper.pdf')).toBe('pdf');
      expect(getFilePreviewCategory('rebel-system/help-for-humans/tutorials/guide.html')).toBe('tutorial');
      expect(getFilePreviewCategory('archive.zip')).toBe('unsupported');
    });

    it('keeps markdown files in the text bucket', () => {
      expect(getFilePreviewCategory('guide.markdown')).toBe('text');
    });

    // Contract pinning: the 13 desktop consumers branch on the exact return-value
    // union `'text' | 'image' | 'video' | 'audio' | 'html' | 'pdf' | 'tutorial' | 'unsupported'`.
    // If any new category value slips in (e.g. 'markdown', 'unknown'), consumer
    // switch statements could silently fall through. This test asserts the exact set.
    it('[contract pinning] returns only the values the 13 legacy consumers expect', () => {
      const observedValues = new Set<string>();
      const probes = [
        'notes.md', 'guide.markdown', 'doc.txt', 'data.json', 'cfg.yaml', 'diff.xml',
        'records.csv', 'app.log',
        'photo.png', 'image.jpg', 'image.jpeg', 'pic.gif', 'img.webp', 'icon.svg', 'bit.bmp',
        'clip.mp4', 'clip.webm', 'clip.mov', 'clip.m4v',
        'audio.mp3', 'audio.wav', 'audio.ogg', 'audio.m4a', 'audio.aac', 'audio.flac',
        'page.html', 'page.htm',
        'paper.pdf',
        'rebel-system/help-for-humans/tutorials/guide.html',
        'archive.zip', 'unknown.xyz', 'Makefile',
      ];
      for (const path of probes) {
        observedValues.add(getFilePreviewCategory(path));
      }
      const allowed = new Set([
        'text', 'image', 'video', 'audio', 'html', 'pdf', 'tutorial', 'unsupported',
      ]);
      for (const v of observedValues) {
        expect(allowed).toContain(v);
      }
    });
  });

  describe('getImageMimeType', () => {
    it('returns the expected MIME type for every supported image extension', () => {
      expect(getImageMimeType('file.png')).toBe('image/png');
      expect(getImageMimeType('file.jpg')).toBe('image/jpeg');
      expect(getImageMimeType('file.jpeg')).toBe('image/jpeg');
      expect(getImageMimeType('file.gif')).toBe('image/gif');
      expect(getImageMimeType('file.webp')).toBe('image/webp');
      expect(getImageMimeType('file.svg')).toBe('image/svg+xml');
      expect(getImageMimeType('file.bmp')).toBe('image/bmp');
      expect(getImageMimeType('file.unknown')).toBe('image/png');
    });
  });

  describe('getFilePrivacy', () => {
    it('detects private paths', () => {
      expect(getFilePrivacy('Chief-of-Staff/notes.md')).toBe('private');
      expect(getFilePrivacy('chief-of-staff/notes.md')).toBe('private');
      expect(getFilePrivacy('rebel-system/help-for-humans/tutorials/guide.html')).toBe('private');
    });

    it('detects shared paths', () => {
      expect(getFilePrivacy('work/plan.md')).toBe('shared');
      expect(getFilePrivacy('Work/plan.md')).toBe('shared');
    });

    // Inherited-gap fix: previously absolute or dotted paths bypassed the
    // prefix match and were classified as `unknown`. They now normalise the
    // same way as relative paths.
    it('normalises absolute and dotted paths (inherited-gap fix)', () => {
      expect(getFilePrivacy('/work/plan.md')).toBe('shared');
      expect(getFilePrivacy('./work/plan.md')).toBe('shared');
      expect(getFilePrivacy('../work/plan.md')).toBe('shared');
      expect(getFilePrivacy('/Chief-of-Staff/notes.md')).toBe('private');
      expect(getFilePrivacy('/rebel-system/help/guide.html')).toBe('private');
      // Windows absolute path
      expect(getFilePrivacy('C:/work/plan.md')).toBe('shared');
      expect(getFilePrivacy('C:\\work\\plan.md')).toBe('shared');
    });

    it('returns unknown for paths not under a recognised root', () => {
      expect(getFilePrivacy('personal/notes.md')).toBe('unknown');
      expect(getFilePrivacy('/personal/notes.md')).toBe('unknown');
      expect(getFilePrivacy('some/other/path.md')).toBe('unknown');
    });
  });
});
