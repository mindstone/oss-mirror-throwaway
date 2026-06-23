#import "ObjCExceptionCatcher.h"

@implementation ObjCExceptionCatcher

+ (BOOL)tryBlock:(void (NS_NOESCAPE ^)(void))block error:(NSError *_Nullable *_Nullable)error {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            *error = [NSError errorWithDomain:@"com.mindstone.moonshine-stt.objc-exception"
                                         code:-1
                                     userInfo:@{
                NSLocalizedDescriptionKey: exception.reason ?: exception.name,
                @"ExceptionName": exception.name,
                @"ExceptionReason": exception.reason ?: @"(no reason)",
                @"ExceptionCallStack": [exception.callStackSymbols componentsJoinedByString:@"\n"] ?: @""
            }];
        }
        return NO;
    }
}

@end
