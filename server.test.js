const assert = require('assert');
const {
    cleanTitle,
    isSafeSuffix,
    isTitleMatch,
    validateUrl,
    wikiNormalize
} = require('./server');

console.log("Starting unit tests...");

try {
    // 1. cleanTitle Tests
    console.log("Running cleanTitle tests...");
    assert.strictEqual(cleanTitle("The Avengers"), "Avengers", "Should remove starting article");
    assert.strictEqual(cleanTitle("A Bug's Life"), "Bug s Life", "Should remove article and handle non-words");
    assert.strictEqual(cleanTitle("Iron Man (2008)"), "Iron Man 2008", "Should remove non-words and multi-space");
    assert.strictEqual(cleanTitle("  Guardians of the Galaxy  "), "Guardians of the Galaxy", "Should trim whitespace");
    assert.strictEqual(cleanTitle("Avengers, The"), "Avengers", "Should handle trailing articles (Note: current regex behavior just strips non-words)");
    assert.strictEqual(cleanTitle("The Batman The"), "Batman", "Should remove both starting and trailing articles");

    // 2. isSafeSuffix Tests
    console.log("Running isSafeSuffix tests...");
    assert.strictEqual(isSafeSuffix("blooper"), true, "Should allow safe single token");
    assert.strictEqual(isSafeSuffix("mid credit scene"), true, "Should allow safe multiple tokens");
    assert.strictEqual(isSafeSuffix("post credits"), true, "Should allow safe tokens");
    assert.strictEqual(isSafeSuffix("director cut"), false, "Should block unsafe token 'director'");
    assert.strictEqual(isSafeSuffix(""), false, "Empty string should return false");
    assert.strictEqual(isSafeSuffix(undefined), false, "Undefined should return false");
    assert.strictEqual(isSafeSuffix("is there a post credit scene"), true, "Should allow question with safe tokens");

    // 3. isTitleMatch Tests
    console.log("Running isTitleMatch tests...");
    assert.strictEqual(isTitleMatch("Iron Man", "iron man"), true, "Exact match");
    assert.strictEqual(isTitleMatch("Iron Man (2008)", "iron man"), true, "Match ignoring year");
    assert.strictEqual(isTitleMatch("Iron Man post credit scene", "iron man"), true, "Prefix match with safe suffix");
    assert.strictEqual(isTitleMatch("Iron Man 2", "iron man"), false, "Prefix match with unsafe suffix '2'");
    assert.strictEqual(isTitleMatch("The Avengers mid credits", "avengers"), true, "Article removal and safe suffix");

    // 4. validateUrl Tests
    console.log("Running validateUrl tests...");
    assert.strictEqual(
        validateUrl("https://aftercredits.com/movie/", "https://aftercredits.com", "aftercredits.com"),
        "https://aftercredits.com/movie/",
        "Should allow exact expected hostname"
    );
    assert.strictEqual(
        validateUrl("https://www.aftercredits.com/movie/", "https://aftercredits.com", "aftercredits.com"),
        "https://www.aftercredits.com/movie/",
        "Should allow www subdomain"
    );
    assert.strictEqual(
        validateUrl("https://evil.com/movie/", "https://aftercredits.com", "aftercredits.com"),
        null,
        "Should block unexpected hostname"
    );
    assert.strictEqual(
        validateUrl("/relative/path", "https://aftercredits.com", "aftercredits.com"),
        "https://aftercredits.com/relative/path",
        "Should handle relative paths using baseUrl"
    );

    // 5. wikiNormalize Tests
    console.log("Running wikiNormalize tests...");
    assert.strictEqual(wikiNormalize("The Avengers"), "avengers", "Should normalize wiki title");

    console.log("✅ All tests passed successfully!");
    process.exit(0);

} catch (error) {
    console.error("❌ Test failed:");
    console.error(error);
    process.exit(1);
}
