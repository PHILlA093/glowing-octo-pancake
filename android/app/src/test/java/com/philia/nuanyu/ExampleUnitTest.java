package com.philia.nuanyu;

import static org.junit.Assert.*;

import org.junit.Test;

/**
 * 主机侧的本地单元测试。
 *
 * 说明：暖屿的业务逻辑（人设铁律、本地安慰句库、流式解析）都在网页层
 * （app/js/），用 Java 单测覆盖不到，那边的验证靠 _scripts/cdp.js
 * 在真机 WebView 里跑真点击。这里只留一个占位，保证 test 源集可编译。
 */
public class ExampleUnitTest {

    @Test
    public void placeholder() {
        assertEquals(4, 2 + 2);
    }
}
