#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Bridges Objective-C exceptions into NSError so Swift `do/catch` can handle them.
/// ONNX Runtime (used by MoonshineVoice) throws ObjC/C++ exceptions on model load
/// failures, which bypass Swift error handling and crash the process with SIGABRT.
@interface ObjCExceptionCatcher : NSObject

+ (BOOL)tryBlock:(void (NS_NOESCAPE ^)(void))block error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
