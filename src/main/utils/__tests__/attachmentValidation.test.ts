import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAttachmentPayload,
  BinaryFileAttachmentPayload,
  DocumentAttachmentPayload,
  ImageAttachmentPayload,
} from '@shared/types';

vi.mock('../systemUtils', () => ({
  resolveLibraryPath: vi.fn(),
}));

vi.mock('../agentTurnUtils', async () => {
  const actual = await vi.importActual<typeof import('../agentTurnUtils')>('../agentTurnUtils');
  return {
    ...actual,
    attachSkillMetadataToTextAttachments: vi.fn((attachments: AgentAttachmentPayload[]) =>
      attachments.map((attachment) => ({ ...attachment, skillMetadata: null }))
    ),
    collectSkillModelRecommendations: vi.fn(() => ({
      claudeAliases: [],
      profileMatches: [],
      unresolvedModels: [],
    })),
  };
});

import {
  MAX_BINARY_ATTACHMENTS,
  MAX_BINARY_SIZE_BYTES,
  MAX_DOCUMENT_ATTACHMENTS,
  MAX_PDF_SIZE_BYTES,
  type AttachmentValidationInput,
  validateAndFilterAttachments,
} from '../attachmentValidation';
import {
  attachSkillMetadataToTextAttachments,
  collectSkillModelRecommendations,
  MAX_ATTACHMENT_CHAR_LENGTH,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_SIZE_BYTES,
  MAX_RENDERER_ATTACHMENTS,
} from '../agentTurnUtils';
import { resolveLibraryPath } from '../systemUtils';

const makeTextAttachment = (overrides?: Partial<AgentAttachmentPayload>): AgentAttachmentPayload => ({
  id: 'text-1',
  name: 'test.txt',
  path: '/workspace/test.txt',
  relativePath: 'test.txt',
  size: 100,
  content: 'hello',
  ...overrides,
});

const makeImageAttachment = (
  overrides?: Partial<ImageAttachmentPayload>
): ImageAttachmentPayload => ({
  id: 'image-1',
  name: 'image.png',
  type: 'image',
  mimeType: 'image/png',
  base64Data: 'aW1hZ2U=',
  sizeBytes: 1024,
  ...overrides,
});

const makeDocumentAttachment = (
  overrides?: Partial<DocumentAttachmentPayload>
): DocumentAttachmentPayload => ({
  id: 'document-1',
  name: 'document.pdf',
  type: 'document',
  mimeType: 'application/pdf',
  base64Data: 'cGRm',
  sizeBytes: 1024,
  ...overrides,
});

const makeBinaryAttachment = (
  overrides?: Partial<BinaryFileAttachmentPayload>
): BinaryFileAttachmentPayload => ({
  id: 'binary-1',
  name: 'archive.zip',
  type: 'binary',
  mimeType: 'application/zip',
  sizeBytes: 1024,
  ...overrides,
});

const makeInput = (overrides: Partial<AttachmentValidationInput> = {}): AttachmentValidationInput => ({
  rawTextAttachments: [],
  rawImageAttachments: [],
  rawDocumentAttachments: [],
  rawExtractedPdfAttachments: [],
  rawOfficeAttachments: [],
  rawTextFileAttachments: [],
  rawBinaryAttachments: [],
  coreDirectory: '/workspace',
  turnLogger: { warn: vi.fn() },
  ...overrides,
});

const mockedResolveLibraryPath = vi.mocked(resolveLibraryPath);
const mockedAttachSkillMetadataToTextAttachments = vi.mocked(attachSkillMetadataToTextAttachments);
const mockedCollectSkillModelRecommendations = vi.mocked(collectSkillModelRecommendations);

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveLibraryPath.mockReturnValue({ root: '/workspace', resolved: '/workspace/resolved.txt' } as any);
  mockedAttachSkillMetadataToTextAttachments.mockImplementation(
    ((attachments: AgentAttachmentPayload[]) =>
      attachments.map((attachment) => ({ ...attachment, skillMetadata: null }))) as never
  );
  mockedCollectSkillModelRecommendations.mockReturnValue({
    claudeAliases: [],
    profileMatches: [],
    unresolvedModels: [],
  } as never);
});

describe('validateAndFilterAttachments', () => {
  it('returns empty arrays when all inputs are empty', () => {
    const input = makeInput();

    const result = validateAndFilterAttachments(input);

    expect(result).toEqual({
      textAttachmentPayload: [],
      imageAttachmentPayload: [],
      documentAttachmentPayload: [],
      extractedPdfAttachmentPayload: [],
      officeAttachmentPayload: [],
      textFileAttachmentPayload: [],
      binaryAttachmentPayload: [],
      skillModelRecommendations: {
        claudeAliases: [],
        profileMatches: [],
        unresolvedModels: [],
      },
      skillEffortRecommendations: [],
    });
    expect(input.turnLogger.warn).not.toHaveBeenCalled();
  });

  it('keeps valid text attachments under the size limit', () => {
    const attachment = makeTextAttachment();
    const input = makeInput({ rawTextAttachments: [attachment] });

    const result = validateAndFilterAttachments(input);

    expect(result.textAttachmentPayload).toEqual([{ ...attachment, skillMetadata: null }]);
    expect(mockedResolveLibraryPath).toHaveBeenCalledWith('test.txt', '/workspace');
    expect(mockedAttachSkillMetadataToTextAttachments).toHaveBeenCalledWith([attachment]);
    expect(input.turnLogger.warn).not.toHaveBeenCalled();
  });

  it('drops oversized text attachments and logs a warning', () => {
    const input = makeInput({
      rawTextAttachments: [
        makeTextAttachment({
          name: 'too-large.txt',
          relativePath: 'too-large.txt',
          content: 'x'.repeat(MAX_ATTACHMENT_CHAR_LENGTH + 1),
        }),
      ],
    });

    const result = validateAndFilterAttachments(input);

    expect(result.textAttachmentPayload).toEqual([]);
    expect(mockedResolveLibraryPath).not.toHaveBeenCalled();
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      {
        relativePath: 'too-large.txt',
        size: MAX_ATTACHMENT_CHAR_LENGTH + 1,
        max: MAX_ATTACHMENT_CHAR_LENGTH,
      },
      'Dropping oversized text attachment'
    );
  });

  it('drops text attachments that fail workspace resolution and logs a warning', () => {
    const validAttachment = makeTextAttachment();
    const invalidAttachment = makeTextAttachment({
      id: 'text-2',
      name: 'missing.txt',
      relativePath: 'missing.txt',
      path: '/workspace/missing.txt',
    });
    mockedResolveLibraryPath.mockImplementation(((relativePath: any) => {
      if (relativePath === 'missing.txt') {
        throw new Error('outside workspace');
      }
      return { root: '/workspace', resolved: `/workspace/${relativePath}` };
    }) as any);
    const input = makeInput({ rawTextAttachments: [validAttachment, invalidAttachment] });

    const result = validateAndFilterAttachments(input);

    expect(result.textAttachmentPayload).toEqual([{ ...validAttachment, skillMetadata: null }]);
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      {
        relativePath: 'missing.txt',
        err: 'outside workspace',
      },
      'Dropping attachment that could not be resolved in workspace'
    );
  });

  it('slices text attachments to the renderer limit and logs a warning', () => {
    const attachments = Array.from({ length: MAX_RENDERER_ATTACHMENTS + 1 }, (_, index) =>
      makeTextAttachment({
        id: `text-${index + 1}`,
        name: `file-${index + 1}.txt`,
        relativePath: `file-${index + 1}.txt`,
        path: `/workspace/file-${index + 1}.txt`,
      })
    );
    const input = makeInput({ rawTextAttachments: attachments });

    const result = validateAndFilterAttachments(input);

    expect(result.textAttachmentPayload).toHaveLength(MAX_RENDERER_ATTACHMENTS);
    expect(result.textAttachmentPayload.map((attachment) => attachment.id)).toEqual(
      attachments.slice(0, MAX_RENDERER_ATTACHMENTS).map((attachment) => attachment.id)
    );
    expect(mockedResolveLibraryPath).toHaveBeenCalledTimes(MAX_RENDERER_ATTACHMENTS);
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      {
        requested: MAX_RENDERER_ATTACHMENTS + 1,
        allowed: MAX_RENDERER_ATTACHMENTS,
      },
      'Too many text attachments provided - extra files will be dropped'
    );
  });

  it('keeps valid images, drops oversized ones, and logs the drop', () => {
    const input = makeInput({
      rawImageAttachments: [
        makeImageAttachment({ id: 'image-ok' }),
        makeImageAttachment({ id: 'image-big', name: 'big.png', sizeBytes: MAX_IMAGE_SIZE_BYTES + 1 }),
      ],
    });

    const result = validateAndFilterAttachments(input);

    expect(result.imageAttachmentPayload.map((attachment) => attachment.id)).toEqual(['image-ok']);
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      { name: 'big.png', size: MAX_IMAGE_SIZE_BYTES + 1, max: MAX_IMAGE_SIZE_BYTES },
      'Dropping oversized image attachment'
    );
  });

  it('slices image attachments to the allowed limit and logs a warning', () => {
    const attachments = Array.from({ length: MAX_IMAGE_ATTACHMENTS + 1 }, (_, index) =>
      makeImageAttachment({ id: `image-${index + 1}`, name: `image-${index + 1}.png` })
    );
    const input = makeInput({ rawImageAttachments: attachments });

    const result = validateAndFilterAttachments(input);

    expect(result.imageAttachmentPayload).toHaveLength(MAX_IMAGE_ATTACHMENTS);
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      { requested: MAX_IMAGE_ATTACHMENTS + 1, allowed: MAX_IMAGE_ATTACHMENTS },
      'Too many image attachments provided - extra images will be dropped'
    );
  });

  it('drops oversized PDF attachments and logs a warning', () => {
    const input = makeInput({
      rawDocumentAttachments: [
        makeDocumentAttachment({ name: 'big.pdf', sizeBytes: MAX_PDF_SIZE_BYTES + 1 }),
      ],
    });

    const result = validateAndFilterAttachments(input);

    expect(result.documentAttachmentPayload).toEqual([]);
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      { name: 'big.pdf', size: MAX_PDF_SIZE_BYTES + 1, max: MAX_PDF_SIZE_BYTES },
      'Dropping oversized document attachment'
    );
  });

  it('slices PDF attachments to the allowed limit and logs a warning', () => {
    const attachments = Array.from({ length: MAX_DOCUMENT_ATTACHMENTS + 1 }, (_, index) =>
      makeDocumentAttachment({ id: `document-${index + 1}`, name: `document-${index + 1}.pdf` })
    );
    const input = makeInput({ rawDocumentAttachments: attachments });

    const result = validateAndFilterAttachments(input);

    expect(result.documentAttachmentPayload).toHaveLength(MAX_DOCUMENT_ATTACHMENTS);
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      { requested: MAX_DOCUMENT_ATTACHMENTS + 1, allowed: MAX_DOCUMENT_ATTACHMENTS },
      'Too many document attachments provided - extra documents will be dropped'
    );
  });

  it('drops oversized binary attachments and logs a warning', () => {
    const input = makeInput({
      rawBinaryAttachments: [
        makeBinaryAttachment({ name: 'huge.zip', sizeBytes: MAX_BINARY_SIZE_BYTES + 1 }),
      ],
    });

    const result = validateAndFilterAttachments(input);

    expect(result.binaryAttachmentPayload).toEqual([]);
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      { name: 'huge.zip', size: MAX_BINARY_SIZE_BYTES + 1, max: MAX_BINARY_SIZE_BYTES },
      'Dropping binary attachment exceeding size limit'
    );
  });

  it('slices binary attachments to the allowed limit and logs a warning', () => {
    const attachments = Array.from({ length: MAX_BINARY_ATTACHMENTS + 1 }, (_, index) =>
      makeBinaryAttachment({ id: `binary-${index + 1}`, name: `binary-${index + 1}.zip` })
    );
    const input = makeInput({ rawBinaryAttachments: attachments });

    const result = validateAndFilterAttachments(input);

    expect(result.binaryAttachmentPayload).toHaveLength(MAX_BINARY_ATTACHMENTS);
    expect(input.turnLogger.warn).toHaveBeenCalledWith(
      { requested: MAX_BINARY_ATTACHMENTS + 1, allowed: MAX_BINARY_ATTACHMENTS },
      'Too many binary attachments provided - extra files will be dropped'
    );
  });

  it('returns skill model and effort recommendations derived from text attachments', () => {
    const attachments = [
      makeTextAttachment({ id: 'text-1', name: 'skill-one.md', relativePath: 'skill-one.md' }),
      makeTextAttachment({ id: 'text-2', name: 'skill-two.md', relativePath: 'skill-two.md' }),
      makeTextAttachment({ id: 'text-3', name: 'note.md', relativePath: 'note.md' }),
    ];
    const enrichedAttachments = [
      { ...attachments[0], skillMetadata: { model: 'opus', effort: 'high' as const } },
      { ...attachments[1], skillMetadata: { model: 'local-model' } },
      { ...attachments[2], skillMetadata: { effort: 'low' as const } },
    ];
    const skillModelRecommendations = {
      claudeAliases: ['opus'],
      profileMatches: [],
      unresolvedModels: ['local-model'],
    };
    mockedAttachSkillMetadataToTextAttachments.mockReturnValue(enrichedAttachments as never);
    mockedCollectSkillModelRecommendations.mockReturnValue(skillModelRecommendations as never);
    const input = makeInput({ rawTextAttachments: attachments });

    const result = validateAndFilterAttachments(input);

    expect(mockedAttachSkillMetadataToTextAttachments).toHaveBeenCalledWith(attachments);
    expect(mockedCollectSkillModelRecommendations).toHaveBeenCalledWith(enrichedAttachments);
    expect(result.textAttachmentPayload).toEqual(enrichedAttachments);
    expect(result.skillModelRecommendations).toEqual(skillModelRecommendations);
    expect(result.skillEffortRecommendations).toEqual(['high', 'low']);
  });
});
